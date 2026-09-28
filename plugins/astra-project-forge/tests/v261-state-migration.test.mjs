import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../server/state-store.mjs';
import { selectDelta } from '../server/context-efficiency.mjs';
import { makeEvidenceKey, fingerprintDependencies } from '../server/evidence-cache.mjs';
import * as ledgerApi from '../server/efficiency-ledger.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'astra-v261-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ProjectStore(dir);
  await store.initializeProject({ projectId: 'p', goal: 'Preserve verified state' });
  const file = path.join(dir, (await readdir(dir)).find(name => name.endsWith('.json')));
  return { store, dir, file, disk: () => readFile(file, 'utf8') };
}

for (const schemaVersion of [1, 2]) {
  test(`schema ${schemaVersion} gains persisted defaults once without losing history or metadata`, async t => {
    const { store, dir, file, disk } = await fixture(t);
    const raw = JSON.parse(await disk());
    raw.schemaVersion = schemaVersion;
    delete raw.revision;
    delete raw.efficiency;
    raw.observations = [{ id: 'obs-1', observation: 'legacy fact', extra: { retained: true } }];
    raw.extra = { retained: true };
    raw.usage = { ...raw.usage, firstUseNoticeAcknowledged: true, deepWarningAcknowledged: true, vendor: 'keep' };
    if (schemaVersion === 1) delete raw.goalGraph;
    await writeFile(file, JSON.stringify(raw));
    const project = await store.getProject('p');
    assert.equal(project.efficiency?.policy, 'balanced');
    assert.equal(project.efficiency.reasoningLevel, 'low');
    assert.equal(project.efficiency.recentlyEscalated, false);
    assert.equal(project.efficiency.recentlyDeescalated, false);
    assert.deepEqual(project.efficiency.evidenceCache, []);
    assert.deepEqual(project.efficiency.failedStrategies, []);
    assert.equal(project.efficiency.ledger.usefulCycles, 0);
    assert.equal(project.schemaVersion, 2);
    assert.ok(Number.isSafeInteger(project.revision) && project.revision > 0);
    assert.deepEqual(project.observations, raw.observations);
    assert.deepEqual(project.extra, raw.extra);
    assert.deepEqual(project.usage, raw.usage);
    const persisted = await disk();
    assert.deepEqual(JSON.parse(persisted), project);
    assert.deepEqual(await new ProjectStore(dir).getProject('p'), project);
    assert.equal(await disk(), persisted);
  });
}

test('partial efficiency state preserves hysteresis, counters and additive metadata', async t => {
  const { store, dir, file, disk } = await fixture(t);
  const raw = JSON.parse(await disk());
  raw.efficiency = {
    policy: ' PERFORMANCE ', reasoningLevel: 'high', recentlyEscalated: true,
    recentlyDeescalated: true, failedStrategies: [{ strategy: 'old', extra: true }],
    vendor: { retained: true }, ledger: { usefulCycles: 3, vendor: 'keep' },
  };
  await writeFile(file, JSON.stringify(raw));
  const project = await store.getProject('p');
  assert.equal(project.efficiency.policy, 'performance');
  assert.equal(project.efficiency.reasoningLevel, 'high');
  assert.equal(project.efficiency.recentlyEscalated, true);
  assert.equal(project.efficiency.recentlyDeescalated, true);
  assert.equal(project.efficiency.ledger.usefulCycles, 3);
  assert.equal(project.efficiency.ledger.avoidedCycles, 0);
  assert.equal(project.efficiency.ledger.vendor, 'keep');
  assert.deepEqual(project.efficiency.vendor, { retained: true });
  assert.deepEqual(project.efficiency.failedStrategies, raw.efficiency.failedStrategies);
  assert.deepEqual((await new ProjectStore(dir).getProject('p')).efficiency, project.efficiency);
});

test('new records and indirect goal updates carry revisions usable by selectDelta after restart', async t => {
  const { store, dir } = await fixture(t);
  const initial = await store.getProject('p');
  assert.equal(initial.goalGraph[0].revision, initial.revision);
  const prerequisite = await store.addGoal('p', { title: 'Prerequisite' });
  const dependent = await store.addGoal('p', { title: 'Dependent', dependencies: [prerequisite.id] });
  assert.equal(dependent.status, 'blocked');
  const before = await store.getProject('p');
  await store.updateGoal('p', prerequisite.id, { status: 'verified', evidenceIds: ['external-evidence'] });
  const after = await new ProjectStore(dir).getProject('p');
  assert.equal(after.revision, before.revision + 1);
  assert.deepEqual(selectDelta(after.goalGraph, before.revision).map(item => item.id), [prerequisite.id, dependent.id]);
  assert.equal(after.goalGraph.find(item => item.id === dependent.id).status, 'pending');
  assert.equal(after.goalGraph[0].revision, initial.revision);
  assert.equal((await store.getProject('p')).revision, after.revision);
});

test('claims, hypothesis outcomes, lessons and transfers stamp updates without restamping history', async t => {
  const { store, dir } = await fixture(t);
  const observation = await store.addObservation('p', { observation: 'stable fact' });
  const claim = await store.addClaim('p', { statement: 'pending claim' });
  const hypothesis = await store.addHypothesis('p', { hypothesis: 'testable hypothesis' });
  const transfer = await store.addTransferCandidate('p', { sourceProjectId: 'source', lesson: 'candidate' });
  const before = await store.getProject('p');
  await store.updateClaim('p', claim.id, { status: 'known', evidenceIds: [observation.id] });
  await store.addExperiment('p', { hypothesisId: hypothesis.id, action: 'test', result: 'passed', outcome: 'supported', lesson: 'verified lesson' });
  await store.validateTransferCandidate('p', transfer.id, [observation.id]);
  const project = await new ProjectStore(dir).getProject('p');
  for (const section of ['claims', 'hypotheses', 'experiments', 'lessons', 'transferCandidates']) {
    assert.equal(selectDelta(project[section], before.revision).length, 1, section);
  }
  assert.deepEqual(project.observations, [observation]);
  assert.deepEqual(selectDelta(project.observations, before.revision), []);
});

test('plans, evaluations, adaptations, checkpoints and consolidation stamp actual writes', async t => {
  const { store } = await fixture(t);
  const before = await store.getProject('p');
  await store.addPlan('p', { action: 'probe', why: 'resolve uncertainty' });
  await store.addEvaluation('p', { summary: 'probe passed', outcome: 'verified' });
  await store.addAdaptation('p', { failedAction: 'old', nextStrategy: 'new', diagnosis: 'observed failure', failureCategory: 'wrong_hypothesis' });
  await store.addCheckpoint('p', { summary: 'milestone' });
  const result = await store.consolidate('p', { verifiedResult: 'done', evidence: ['test'], lessons: ['retained'], remainingUncertainty: ['external'] });
  const after = await store.getProject('p');
  for (const section of ['plans', 'evaluations', 'adaptations', 'checkpoints', 'lessons']) {
    assert.equal(selectDelta(after[section], before.revision).length, 1, section);
  }
  assert.equal(result.revision, after.revision);
  assert.deepEqual(after.consolidation.remainingUncertainty, ['external']);
});

test('invalid revisions and exhausted revision space never alter disk', async t => {
  const { store, file, disk } = await fixture(t);
  const raw = JSON.parse(await disk());
  for (const revision of [-1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1]) {
    for (const where of ['project', 'record']) {
      const invalid = structuredClone(raw);
      if (where === 'project') invalid.revision = revision;
      else invalid.goalGraph[0].revision = revision;
      await writeFile(file, JSON.stringify(invalid));
      const before = await disk();
      await assert.rejects(() => store.getProject('p'), /revision/i);
      assert.equal(await disk(), before);
    }
  }
  raw.revision = Number.MAX_SAFE_INTEGER;
  await writeFile(file, JSON.stringify(raw));
  const before = await disk();
  await assert.rejects(() => store.addObservation('p', { observation: 'cannot stamp' }), /revision/i);
  assert.equal(await disk(), before);
});

test('ledger events validate amounts, preserve provenance and never mutate inputs', () => {
  assert.equal(typeof ledgerApi.applyEfficiencyEvent, 'function');
  const original = Object.freeze({ ...ledgerApi.emptyEfficiencyLedger(), vendor: 'keep' });
  const event = Object.freeze({ type: 'usefulCycles', amount: 2, provenance: { source: 'reported', reference: 'run-1' } });
  const next = ledgerApi.applyEfficiencyEvent(original, event);
  assert.equal(next.usefulCycles, 2);
  assert.equal(original.usefulCycles, 0);
  assert.equal(next.vendor, 'keep');
  assert.deepEqual(next.events[0], event);
  for (const amount of [-1, 0.5, NaN, Infinity, -Infinity, '2', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => ledgerApi.applyEfficiencyEvent(next, { ...event, amount }), /amount|integer/i);
  }
  assert.equal(ledgerApi.applyEfficiencyEvent(next, { ...event, amount: 0 }).usefulCycles, 2);
  assert.throws(() => ledgerApi.applyEfficiencyEvent({ usefulCycles: Number.MAX_SAFE_INTEGER }, event), /integer|overflow/i);
});

test('ledger rejects unknown events, unsupported telemetry, invalid existing counters and missing provenance', () => {
  assert.equal(typeof ledgerApi.applyEfficiencyEvent, 'function');
  const provenance = { source: 'reported', reference: 'run-1' };
  for (const event of [
    {}, { type: 'tokens', amount: 3, provenance }, { type: 'billing', amount: 3, provenance },
    { type: 'usefulCycles', provenance, tokenSavings: 10 },
    { type: 'usefulCycles' }, { type: 'usefulCycles', provenance: { source: 'advice', reference: 'route' } },
    { type: 'stop', provenance, reason: '' }, { type: 'stop', provenance, reason: 'SUCCESS_VERIFIED', amount: 1 },
  ]) assert.throws(() => ledgerApi.applyEfficiencyEvent(null, event));
  for (const value of [-1, 0.5, NaN, Infinity, '1', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => ledgerApi.applyEfficiencyEvent({ avoidedCycles: value }, { type: 'stop', reason: 'SUCCESS_VERIFIED', provenance }), /integer/i);
  }
  const stopped = ledgerApi.applyEfficiencyEvent(null, { type: 'stop', reason: 'SUCCESS_VERIFIED', provenance });
  assert.equal(stopped.stopReason, 'SUCCESS_VERIFIED');
  assert.equal(stopped.usefulCycles, 0);
});

test('policy and reasoning state persist without claiming executed work or host effort changes', async t => {
  const { store, dir } = await fixture(t);
  assert.equal(typeof store.setEfficiencyPolicy, 'function');
  assert.equal((await store.setEfficiencyPolicy('p', ' ECO ')).policy, 'eco');
  assert.equal((await store.setEfficiencyPolicy('p', 'unknown')).policy, 'balanced');
  assert.equal(typeof store.setReasoningState, 'function');
  await store.setReasoningState('p', { reasoningLevel: 'high', recentlyEscalated: true, recentlyDeescalated: false });
  await store.setReasoningState('p', { reasoningLevel: 'medium', recentlyEscalated: false, recentlyDeescalated: true });
  await store.setUsageState('p', { lastProfile: 'deep', lastUsageImpact: 'HIGH', firstUseNoticeAcknowledged: true });
  const project = await new ProjectStore(dir).getProject('p');
  assert.equal(project.efficiency.reasoningLevel, 'medium');
  assert.equal(project.efficiency.recentlyEscalated, false);
  assert.equal(project.efficiency.recentlyDeescalated, true);
  assert.equal(project.efficiency.ledger.reasoningEscalations, 0);
  assert.equal(project.efficiency.ledger.usefulCycles, 0);
  assert.equal(project.efficiency.ledger.duplicateToolCallsAvoided, 0);
  assert.deepEqual(project.efficiency.ledger.events, []);
  assert.equal(project.usage.lastProfile, 'deep');
  assert.equal(project.usage.firstUseNoticeAcknowledged, true);
});

test('reported events persist their source and reject invalid input without touching disk', async t => {
  const { store, dir, disk } = await fixture(t);
  assert.equal(typeof store.recordEfficiencyEvent, 'function');
  const provenance = { source: 'reported', reference: 'caller:run-1' };
  const ledger = await store.recordEfficiencyEvent('p', { type: 'usefulCycles', amount: 2, provenance });
  assert.equal(ledger.usefulCycles, 2);
  assert.deepEqual(ledger.events[0].provenance, provenance);
  assert.deepEqual((await new ProjectStore(dir).getProject('p')).efficiency.ledger, ledger);
  for (const event of [
    { type: 'madeUp', provenance }, { type: 'usefulCycles', amount: NaN, provenance },
    { type: 'usefulCycles', amount: -1, provenance }, { type: 'usefulCycles', amount: Infinity, provenance },
    { type: 'usefulCycles', amount: Number.MAX_SAFE_INTEGER, provenance },
    { type: 'usefulCycles', tokens: 42, provenance },
    { type: 'reusedEvidence', provenance: { source: 'store', reference: 'spoofed' } },
  ]) {
    const before = await disk();
    await assert.rejects(() => store.recordEfficiencyEvent('p', event));
    assert.equal(await disk(), before);
  }
});

test('invalid persisted counters reject reads without rewriting the project', async t => {
  const { store, file, disk } = await fixture(t);
  const raw = JSON.parse(await disk());
  for (const count of [-1, 1.5, '2', null, Number.MAX_SAFE_INTEGER + 1]) {
    raw.efficiency.ledger.usefulCycles = count;
    await writeFile(file, JSON.stringify(raw));
    const before = await disk();
    await assert.rejects(() => store.getProject('p'), /integer/i);
    assert.equal(await disk(), before);
  }
});

const evidence = (overrides = {}) => ({
  evidenceId: 'ev-1', kind: 'test', target: 'router', params: { test: 'focused' },
  dependencies: ['src/router@hash1'], dependencyIds: ['src/router'],
  freshness: 'fresh', result: { passed: 4 }, ...overrides,
});

test('cache revisions use canonical keys despite duplicate additive IDs', async t => {
  const { store, dir } = await fixture(t);
  const aInput = evidence({ id: 'external-test', target: 'a', evidenceId: 'ev-a', dependencies: [], dependencyIds: [] });
  const bInput = evidence({ id: 'external-test', target: 'b', evidenceId: 'ev-b', dependencies: [], dependencyIds: [] });
  const a = await store.upsertEvidenceRecord('p', aInput);
  const b = await store.upsertEvidenceRecord('p', bInput);
  const before = await store.getProject('p');
  await store.addObservation('p', { observation: 'unrelated' });
  const restarted = new ProjectStore(dir);
  const after = await restarted.getProject('p');
  assert.deepEqual(after.efficiency.evidenceCache, [a, b]);
  assert.deepEqual(selectDelta(after.efficiency.evidenceCache, before.revision), []);
  const updated = await restarted.upsertEvidenceRecord('p', { ...aInput, freshness: 'stale' });
  const changed = await restarted.getProject('p');
  assert.deepEqual(selectDelta(changed.efficiency.evidenceCache, after.revision), [updated]);
  assert.deepEqual(changed.efficiency.evidenceCache.find(item => item.key === b.key), b);
});

test('cache upsert persists canonical identity and preserves metadata on replacement', async t => {
  const { store, dir } = await fixture(t);
  assert.equal(typeof store.upsertEvidenceRecord, 'function');
  const input = evidence({ vendor: { retained: true } });
  const saved = await store.upsertEvidenceRecord('p', input);
  assert.equal(saved.key, makeEvidenceKey(input));
  assert.equal(saved.dependencyFingerprint, fingerprintDependencies(['src/router@hash1']));
  assert.ok(Number.isSafeInteger(saved.revision));
  assert.equal(input.key, undefined);
  const updated = await store.upsertEvidenceRecord('p', evidence({ evidenceId: 'ev-2', result: { passed: 5 } }));
  assert.ok(updated.revision > saved.revision);
  assert.deepEqual(updated.vendor, { retained: true });
  const project = await new ProjectStore(dir).getProject('p');
  assert.deepEqual(project.efficiency.evidenceCache, [updated]);
  assert.equal(project.efficiency.ledger.reusedEvidence, 0);
});

test('cache lookup is stable across unrelated writes and reuse records only an observed retrieval', async t => {
  const { store, dir, disk } = await fixture(t);
  assert.equal(typeof store.upsertEvidenceRecord, 'function');
  const record = await store.upsertEvidenceRecord('p', evidence());
  assert.equal(typeof store.findReusableEvidence, 'function');
  const before = await disk();
  assert.deepEqual(await store.findReusableEvidence('p', evidence()), record);
  assert.deepEqual(await store.findReusableEvidence('p', evidence()), record);
  assert.equal(await disk(), before);
  await store.addObservation('p', { observation: 'unrelated' });
  assert.deepEqual(await new ProjectStore(dir).findReusableEvidence('p', evidence()), record);
  assert.equal(await store.findReusableEvidence('p', evidence({ dependencies: ['src/router@hash2'] })), null);
  assert.equal(await store.findReusableEvidence('p', evidence({ target: 'other' })), null);
  assert.equal(typeof store.reuseEvidence, 'function');
  assert.deepEqual(await store.reuseEvidence('p', evidence()), record);
  const project = await store.getProject('p');
  assert.equal(project.efficiency.ledger.reusedEvidence, 1);
  assert.equal(project.efficiency.ledger.duplicateToolCallsAvoided, 0);
  assert.equal(project.efficiency.ledger.usefulCycles, 0);
  assert.deepEqual(project.efficiency.ledger.events[0].provenance, { source: 'store', reference: `reuseEvidence:${record.key}` });
  const after = await disk();
  assert.equal(await store.reuseEvidence('p', evidence({ target: 'missing' })), null);
  assert.equal(await disk(), after);
});

test('selective invalidation and risk prevent unsafe reuse without losing unaffected evidence', async t => {
  const { store, dir } = await fixture(t);
  assert.equal(typeof store.upsertEvidenceRecord, 'function');
  const a = await store.upsertEvidenceRecord('p', evidence());
  const bInput = evidence({ evidenceId: 'ev-b', target: 'other', dependencies: ['src/other@1'], dependencyIds: ['src/other'], freshness: 'probably_fresh' });
  const b = await store.upsertEvidenceRecord('p', bInput);
  const invalidInput = evidence({ target: 'invalid', freshness: 'invalidated' });
  await store.upsertEvidenceRecord('p', invalidInput);
  const before = await store.getProject('p');
  assert.equal(typeof store.invalidateEvidence, 'function');
  const records = await store.invalidateEvidence('p', ['src/router']);
  assert.equal(records.find(item => item.key === a.key).freshness, 'stale');
  assert.deepEqual(records.find(item => item.key === b.key), b);
  assert.equal(selectDelta(records, before.revision).length, 1);
  const restarted = new ProjectStore(dir);
  assert.equal(await restarted.findReusableEvidence('p', evidence()), null);
  assert.equal(await restarted.findReusableEvidence('p', invalidInput), null);
  assert.deepEqual(await restarted.findReusableEvidence('p', bInput), b);
  assert.equal(await restarted.findReusableEvidence('p', { ...bInput, risk: 'high' }), null);
});

test('invalid cache records, queries and reasoning patches cannot alter persisted bytes', async t => {
  const { store, disk } = await fixture(t);
  assert.equal(typeof store.upsertEvidenceRecord, 'function');
  await store.upsertEvidenceRecord('p', evidence());
  for (const patch of [
    { evidenceId: '' }, { kind: '' }, { target: 3 }, { dependencies: undefined },
    { dependencies: [''] }, { dependencyIds: null }, { dependencyIds: [1] },
    { key: 'forged' }, { dependencyFingerprint: 'forged' }, { freshness: 'unknown' },
    { params: { invalid: NaN } }, { result: Infinity }, { revision: -1 },
  ]) {
    const before = await disk();
    await assert.rejects(() => store.upsertEvidenceRecord('p', evidence(patch)));
    assert.equal(await disk(), before);
  }
  for (const action of [
    () => store.invalidateEvidence('p', [null]),
    () => store.findReusableEvidence('p', { kind: 'test', target: 'router' }),
    () => store.findReusableEvidence('p', evidence({ risk: 'typo' })),
    () => store.setReasoningState('p', { reasoningLevel: 'typo' }),
    () => store.setReasoningState('p', { recentlyEscalated: 'true' }),
    () => store.setReasoningState('p', { hostEffortChanged: true }),
  ]) {
    const before = await disk();
    await assert.rejects(action);
    assert.equal(await disk(), before);
  }
});

test('invalid new events and records cannot trigger a legacy migration write', async t => {
  const { store, file, disk } = await fixture(t);
  const raw = JSON.parse(await disk());
  delete raw.efficiency;
  delete raw.revision;
  await writeFile(file, JSON.stringify(raw));
  assert.equal(typeof store.recordEfficiencyEvent, 'function');
  const before = await disk();
  await assert.rejects(() => store.recordEfficiencyEvent('p', { type: 'tokens' }));
  await assert.rejects(() => store.upsertEvidenceRecord('p', evidence({ key: 'wrong' })));
  await assert.rejects(() => store.invalidateEvidence('p', [null]));
  assert.equal(await disk(), before);
});

test('intentional project reinitialization preserves monotonic revisions', async t => {
  const { store, dir } = await fixture(t);
  await store.addObservation('p', { observation: 'old run' });
  const before = await store.getProject('p');
  const reset = await new ProjectStore(dir).initializeProject({ projectId: 'p', goal: 'New run' });
  assert.equal(reset.revision, before.revision + 1);
  assert.deepEqual(reset.observations, []);
  assert.equal(selectDelta(reset.goalGraph, before.revision).length, 1);
});

test('event accessors cannot run or inject inconsistent data during validation', () => {
  let accessed = false;
  const event = {
    get type() { accessed = true; return 'usefulCycles'; },
    provenance: { source: 'reported', reference: 'run-1' },
  };
  assert.throws(() => ledgerApi.applyEfficiencyEvent(null, event), TypeError);
  assert.equal(accessed, false);
  const provenance = { source: 'reported', get reference() { accessed = true; return 'run-1'; } };
  assert.throws(() => ledgerApi.applyEfficiencyEvent(null, { type: 'usefulCycles', provenance }), TypeError);
  assert.equal(accessed, false);
});

test('cache registrations with dependencies require invalidation IDs', async t => {
  const { store, disk } = await fixture(t);
  const before = await disk();
  await assert.rejects(() => store.upsertEvidenceRecord('p', evidence({ dependencyIds: [] })), /dependency/i);
  assert.equal(await disk(), before);
});

test('malformed legacy cache metadata is retained but never reused', async t => {
  const { store, file, disk } = await fixture(t);
  const raw = JSON.parse(await disk());
  const record = evidence();
  raw.efficiency.evidenceCache = [{
    ...record, key: makeEvidenceKey(record), dependencyFingerprint: fingerprintDependencies(record.dependencies),
    dependencies: ['different@hash'], vendor: { retained: true },
  }];
  await writeFile(file, JSON.stringify(raw));
  const before = await disk();
  assert.equal(await store.findReusableEvidence('p', record), null);
  assert.deepEqual((await store.getProject('p')).efficiency.evidenceCache, raw.efficiency.evidenceCache);
  assert.equal(await disk(), before);
});
