import test from 'node:test';
import assert from 'node:assert/strict';
import { selectDelta, compactContext, progressiveResult } from '../server/context-efficiency.mjs';

test('delta selects strictly newer revisions without sorting or mutating records', () => {
  const items = Object.freeze([
    Object.freeze({ id: 'newest', revision: 4, evidenceIds: ['ev-1'] }),
    Object.freeze({ id: 'boundary', revision: 2 }),
    Object.freeze({ id: 'newer', revision: 3 }),
  ]);
  assert.deepEqual(selectDelta(items, 2), [items[0], items[2]]);
  assert.deepEqual(selectDelta(items, 4), []);
  assert.deepEqual(selectDelta(items, 5), []);
});

test('delta treats unstamped legacy records as revision zero and supports safe integer boundaries', () => {
  const items = [{ id: 'legacy' }, { id: 'zero', revision: 0 }, { id: 'one', revision: 1 }];
  assert.deepEqual(selectDelta(), []);
  assert.deepEqual(selectDelta(items), [items[2]]);
  assert.deepEqual(selectDelta([{ revision: Number.MAX_SAFE_INTEGER }], Number.MAX_SAFE_INTEGER - 1), [{ revision: Number.MAX_SAFE_INTEGER }]);
  assert.deepEqual(selectDelta([{ revision: Number.MAX_SAFE_INTEGER }], Number.MAX_SAFE_INTEGER), []);
});

test('delta rejects invalid cursors even for empty collections instead of coercing them', () => {
  for (const revision of [null, '2', '', false, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, {}, 1n]) {
    assert.throws(() => selectDelta([], revision), TypeError);
  }
});

test('delta validates every record including old revisions and malformed collections', () => {
  for (const items of [null, {}, 'items', [null], [[]], [1], Array(1)]) {
    assert.throws(() => selectDelta(items), TypeError);
  }
  for (const revision of [null, undefined, '2', false, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => selectDelta([{ revision }], 100), TypeError);
  }
});

test('compaction keeps known facts, all active goals and unresolved claims with their evidence', () => {
  const project = {
    projectId: 'p', schemaVersion: 2, revision: 12,
    goalGraph: ['verified', 'active', 'pending', 'blocked', 'abandoned'].map(status => ({ id: status, status, evidenceIds: ['ev-goal'] })),
    claims: ['known', 'unknown', 'inferred', 'contradicted'].map(status => ({ id: status, status, evidenceIds: ['ev-claim'], sourceRefs: ['source-1'] })),
    lessons: ['verified lesson'],
  };
  const result = compactContext(project);
  assert.deepEqual(result.stableFacts, [project.claims[0]]);
  assert.deepEqual(result.activeGoals, project.goalGraph.slice(1, 4));
  assert.deepEqual(result.unresolvedClaims, project.claims.slice(1));
  assert.deepEqual(result.verifiedLessons, ['verified lesson']);
  assert.deepEqual(result.archiveRef, { projectId: 'p', schemaVersion: 2, revision: 12 });
});

test('compaction verifies stored experiment lessons using source outcomes, not lesson labels', () => {
  const lessons = ['supported', 'falsified', 'inconclusive', 'mixed', 'missing'].map(outcome => ({
    id: `lesson-${outcome}`, text: outcome, sourceExperimentId: `exp-${outcome}`, status: 'verified', evidenceIds: [`ev-${outcome}`],
  }));
  const project = {
    lessons: [...lessons, { id: 'unproven', text: 'unproven', status: 'verified' }],
    experiments: ['supported', 'falsified', 'inconclusive', 'mixed'].map(outcome => ({ id: `exp-${outcome}`, outcome, result: outcome })),
  };
  assert.deepEqual(compactContext(project).verifiedLessons, [lessons[0]]);
});

test('consolidated lessons require matching source text and nonempty source evidence', () => {
  const lesson = { id: 'lesson-1', text: 'validated', sourceExperimentId: null, createdAt: '2026-09-12T00:00:00Z' };
  const consolidation = { verifiedResult: 'passed', evidence: ['ev-consolidation'], lessons: ['validated'], createdAt: lesson.createdAt };
  const project = { lessons: [lesson, { id: 'old', text: 'unrelated', sourceExperimentId: null }], consolidation };
  assert.deepEqual(compactContext(project).verifiedLessons, [lesson]);
  assert.deepEqual(compactContext({ ...project, consolidation: { ...consolidation, evidence: [] } }).verifiedLessons, []);
  assert.deepEqual(compactContext({ lessons: [lesson] }).verifiedLessons, []);
  const failed = { ...lesson, sourceExperimentId: 'failed' };
  assert.deepEqual(compactContext({ ...project, lessons: [failed], experiments: [{ id: 'failed', outcome: 'falsified' }] }).verifiedLessons, []);
});

test('compaction retains bounded recent changes, evaluations and latest checkpoint with recovery IDs', () => {
  const records = Array.from({ length: 7 }, (_, i) => ({ id: `record-${i}`, revision: i + 1, evidenceIds: [`ev-${i}`] }));
  const project = { projectId: 'p', revision: 7, schemaVersion: 2, evaluations: records, observations: records, experiments: records, plans: records, adaptations: records, checkpoints: records };
  const result = compactContext(project);
  assert.deepEqual(result.recentEvaluations, records.slice(2));
  assert.deepEqual(result.recentChanges, { observations: records.slice(2), experiments: records.slice(2), plans: records.slice(2), adaptations: records.slice(2) });
  assert.deepEqual(result.latestCheckpoint, records[6]);
  assert.deepEqual(result.archiveRef, { projectId: 'p', revision: 7, schemaVersion: 2 });
});

test('compaction retains consolidation provenance for lessons without experiment IDs', () => {
  const project = {
    projectId: 'p', schemaVersion: 2, revision: 8,
    lessons: [{ id: 'lesson-1', text: 'validated', sourceExperimentId: null }],
    consolidation: { verifiedResult: 'passed', lessons: ['validated'], evidence: ['ev-1'], createdAt: '2026-09-12T00:00:00Z' },
  };
  const result = compactContext(project);
  assert.deepEqual(result.consolidationRef, { createdAt: '2026-09-12T00:00:00Z', evidence: ['ev-1'], remainingUncertainty: [] });
  assert.deepEqual(result.archiveRef, { projectId: 'p', schemaVersion: 2, revision: 8 });
  assert.deepEqual(result.verifiedLessons, [{ id: 'lesson-1', text: 'validated', sourceExperimentId: null }]);
});

test('compaction preserves consolidation-only uncertainty with provenance without mutating history', () => {
  const project = Object.freeze({
    projectId: 'p', schemaVersion: 2, revision: 9,
    claims: Object.freeze([]), checkpoints: Object.freeze([]),
    consolidation: Object.freeze({
      verifiedResult: 'focused tests passed', lessons: Object.freeze([]),
      evidence: Object.freeze(['ev-focused']), createdAt: '2026-09-13T00:00:00Z',
      remainingUncertainty: Object.freeze(['Concurrency remains unverified']),
    }),
  });
  const before = structuredClone(project);
  const result = compactContext(project);
  assert.deepEqual(result.consolidationRef, {
    createdAt: '2026-09-13T00:00:00Z', evidence: ['ev-focused'],
    remainingUncertainty: ['Concurrency remains unverified'],
  });
  assert.deepEqual(result.archiveRef, { projectId: 'p', schemaVersion: 2, revision: 9 });
  assert.deepEqual(result.unresolvedClaims, []);
  assert.equal(result.latestCheckpoint, null);
  result.consolidationRef.remainingUncertainty.push('Projection-only note');
  assert.deepEqual(project, before);
  assert.deepEqual(compactContext(project).consolidationRef.remainingUncertainty, ['Concurrency remains unverified']);
});

test('compaction accepts sparse legacy state without fabricating revision metadata', () => {
  assert.deepEqual(compactContext(), {
    stableFacts: [], activeGoals: [], unresolvedClaims: [], verifiedLessons: [], recentEvaluations: [],
    recentChanges: { observations: [], experiments: [], plans: [], adaptations: [] },
    latestCheckpoint: null, consolidationRef: null, archiveRef: {},
  });
  assert.deepEqual(compactContext({ projectId: 'legacy', schemaVersion: 2 }).archiveRef, { projectId: 'legacy', schemaVersion: 2 });
  assert.deepEqual(compactContext({ projectId: 'p', revision: 0 }).archiveRef, { projectId: 'p', revision: 0 });
});

test('compaction is deterministic and leaves the complete project history intact', () => {
  const project = { projectId: 'p', lessons: ['lesson'], claims: [{ id: 'c', status: 'known', evidenceIds: ['ev'] }], evaluations: [{ id: 'e' }], checkpoints: [{ id: 'cp' }] };
  const before = structuredClone(project);
  const freeze = value => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  };
  freeze(project);
  assert.deepEqual(compactContext(project), compactContext(project));
  assert.deepEqual(project, before);
  assert.notEqual(compactContext(project).verifiedLessons, project.lessons);
});

test('progressive results default to summary and reveal larger levels only when explicit', () => {
  const payload = { summary: { count: 2 }, relevant: [{ id: 'a' }], full: [{ id: 'a' }, { id: 'b' }] };
  assert.deepEqual(progressiveResult(payload), { count: 2 });
  assert.deepEqual(progressiveResult(payload, 'relevant'), [{ id: 'a' }]);
  assert.deepEqual(progressiveResult(payload, 'full'), [{ id: 'a' }, { id: 'b' }]);
  for (const level of ['raw', 'FULL', '', null, 1]) assert.deepEqual(progressiveResult(payload, level), { count: 2 });
});

test('progressive fallbacks only move toward smaller results and preserve falsy payloads', () => {
  assert.equal(progressiveResult(), null);
  assert.equal(progressiveResult({ full: 'raw' }), null);
  assert.equal(progressiveResult({ full: 'raw' }, 'relevant'), null);
  assert.equal(progressiveResult({ summary: 'small', relevant: 'medium' }, 'full'), 'medium');
  assert.equal(progressiveResult({ summary: 'small', full: null }, 'full'), 'small');
  assert.equal(progressiveResult({}, 'full'), null);
  assert.equal(progressiveResult({ summary: 'small' }, 'relevant'), 'small');
  for (const value of [false, 0, '', []]) {
    assert.deepEqual(progressiveResult({ summary: value }), value);
    assert.deepEqual(progressiveResult({ summary: 'small', relevant: value }, 'relevant'), value);
    assert.deepEqual(progressiveResult({ summary: 'small', full: value }, 'full'), value);
  }
});

test('summary and relevant selection do not access more expensive payload levels', () => {
  const payload = { summary: 'small', get relevant() { assert.fail('relevant accessed'); }, get full() { assert.fail('full accessed'); } };
  assert.equal(progressiveResult(payload), 'small');
  assert.equal(progressiveResult({ relevant: 'medium', get full() { assert.fail('full accessed'); } }, 'relevant'), 'medium');
});
