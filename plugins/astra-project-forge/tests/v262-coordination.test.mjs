import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../server/state-store.mjs';

const evidence = (patch = {}) => ({ evidenceId: 'e1', kind: 'test', target: 'source', params: null,
  dependencies: ['source:v1'], dependencyIds: ['source'], freshness: 'fresh', result: { passed: true }, ...patch });
async function setup(criteria = ['passes']) {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-coordination-'));
  const store = new ProjectStore(root);
  const project = await store.initializeProject({ projectId: 'p', goal: 'Complete safely', successCriteria: criteria });
  const target = path.join(root, (await readdir(root)).find(name => name.endsWith('.json')));
  return { root, store, project, target };
}
async function core() {
  assert.equal(typeof ProjectStore.prototype.coordinateEvaluation, 'function', 'coordination API must exist');
  return import('../server/coordination-core.mjs');
}
async function request(store, operationId = 'op', patch = {}) {
  const { getStateIdentity } = await core();
  const identity = getStateIdentity(await store.getProject('p'));
  return { outcome: 'verified', summary: 'Reported verification', evidenceIds: ['e1'],
    coordination: { operationId, expectedRevision: identity.revision, stateEpoch: identity.epoch,
      evidenceRecords: [evidence()], criteriaUpdates: [{ goalId: 'goal-root', criterion: 'passes', satisfied: true, evidenceIds: ['e1'] }], ...patch } };
}

test('fusion stores evidence, evaluation, explicit criteria/claims, ledger and failure memory in one revision', async () => {
  const { store } = await setup();
  const claim = await store.addClaim('p', { statement: 'It passes', status: 'unknown' });
  const plan = await store.addPlan('p', { action: 'test', why: 'verify', strategyKey: 'strategy' });
  const input = await request(store, 'fusion', { claimUpdates: [{ claimId: claim.id, status: 'known', evidenceIds: ['e1'] }],
    efficiencyEvents: [{ type: 'usefulCycles', amount: 1, provenance: { source: 'reported', reference: 'run:1' } }] });
  input.planId = plan.id; input.outcome = 'blocked';
  const result = await store.coordinateEvaluation('p', input);
  const state = await store.getProject('p');
  assert.equal(state.revision, input.coordination.expectedRevision + 1);
  assert.equal(state.evaluations.length, 1); assert.equal(state.efficiency.evidenceCache.length, 1);
  assert.equal(state.claims[0].status, 'known'); assert.equal(state.coordination.criteria[0].satisfied, true);
  assert.equal(state.efficiency.ledger.usefulCycles, 1); assert.equal(state.efficiency.failedStrategies.length, 1);
  assert.equal(result.identity.revision, state.revision); assert.equal(result.replayed, false);
  assert.equal(result.completion.recommended, false); assert.equal(result.completion.assessmentSource, 'reported');
  assert.ok(result.refs.every(ref => ref.projectId === 'p' && ref.epoch === result.identity.epoch));
});

test('fused invalidation preserves incoming fresh evidence for criteria and known claims', async () => {
  const { store } = await setup();
  await store.upsertEvidenceRecord('p', evidence({ evidenceId: 'old' }));
  await store.upsertEvidenceRecord('p', evidence({ evidenceId: 'unrelated', target: 'other', dependencies: ['other:v1'], dependencyIds: ['other'] }));
  const claim = await store.addClaim('p', { statement: 'Updated source passes', status: 'unknown' });
  const input = await request(store, 'invalidate-and-refresh', {
    changedDependencyIds: ['source'], evidenceRecords: [evidence({ dependencies: ['source:v2'] })],
    claimUpdates: [{ claimId: claim.id, status: 'known', evidenceIds: ['e1'] }],
  });
  const result = await store.coordinateEvaluation('p', input);
  const state = await store.getProject('p');
  assert.deepEqual(Object.fromEntries(state.efficiency.evidenceCache.map(item => [item.evidenceId, item.freshness])),
    { old: 'stale', unrelated: 'fresh', e1: 'fresh' });
  assert.equal(state.claims.find(item => item.id === claim.id).status, 'known');
  assert.equal(state.goalGraph.find(item => item.id === 'goal-root').status, 'verified');
  assert.equal(result.completion.recommended, true);
  assert.deepEqual(result.completion.missingCriteria, []);
  assert.deepEqual(result.completion.uncertainties, []);
  assert.equal(state.revision, input.coordination.expectedRevision + 1);
});

test('fused invalidation allows fresh same-ID replacement at the existing cache key', async () => {
  const { store } = await setup();
  await store.coordinateEvaluation('p', await request(store));
  const input = await request(store, 'replace-after-change', {
    changedDependencyIds: ['source'], evidenceRecords: [evidence({ result: { rerun: true } })],
  });
  const result = await store.coordinateEvaluation('p', input);
  const state = await store.getProject('p');
  assert.equal(state.efficiency.evidenceCache.length, 1);
  assert.equal(state.efficiency.evidenceCache[0].evidenceId, 'e1');
  assert.equal(state.efficiency.evidenceCache[0].freshness, 'fresh');
  assert.deepEqual(state.efficiency.evidenceCache[0].result, { rerun: true });
  assert.equal(result.completion.recommended, true);
});

test('fused invalidation does not promote stale incoming criterion or claim support', async () => {
  const { store, target } = await setup();
  await store.upsertEvidenceRecord('p', evidence({ evidenceId: 'old' }));
  const claim = await store.addClaim('p', { statement: 'Source passes', status: 'unknown' });
  const patch = { changedDependencyIds: ['source'], evidenceRecords: [evidence({ dependencies: ['source:v2'], freshness: 'stale' })] };
  const input = await request(store, 'stale-claim', { ...patch,
    claimUpdates: [{ claimId: claim.id, status: 'known', evidenceIds: ['e1'] }] });
  const before = await readFile(target);
  await assert.rejects(store.coordinateEvaluation('p', input), /Known claim requires fresh evidence/);
  assert.deepEqual(await readFile(target), before);
  const result = await store.coordinateEvaluation('p', await request(store, 'stale-criterion', patch));
  const state = await store.getProject('p');
  assert.equal(state.efficiency.evidenceCache.find(item => item.evidenceId === 'e1').freshness, 'stale');
  assert.equal(result.completion.recommended, false);
  assert.ok(result.completion.missingCriteria.some(item => item.criterion === 'passes'));
  assert.equal(state.claims.find(item => item.id === claim.id).status, 'unknown');
});

test('fused invalidation rolls back cached evidence on invalid incoming records and late errors', async () => {
  const { store, target } = await setup();
  await store.coordinateEvaluation('p', await request(store));
  const before = await readFile(target);
  for (const [operationId, patch, error] of [
    ['invalid-incoming', { evidenceRecords: [evidence({ dependencies: ['source:v2'], dependencyIds: [] })] }, /Dependency IDs/],
    ['late-error', { evidenceRecords: [evidence({ result: { rerun: true } })],
      efficiencyEvents: [{ type: 'usefulCycles', provenance: { source: 'store', reference: 'fake' } }] }, /reported/],
  ]) {
    const input = await request(store, operationId, { changedDependencyIds: ['source'], ...patch });
    await assert.rejects(store.coordinateEvaluation('p', input), error);
    assert.deepEqual(await readFile(target), before);
  }
});

test('invalid final update rolls back every fused change and exact bytes', async () => {
  const { store, target } = await setup();
  const input = await request(store, 'rollback', { efficiencyEvents: [{ type: 'usefulCycles', provenance: { source: 'store', reference: 'fake' } }] });
  const before = await readFile(target);
  await assert.rejects(store.coordinateEvaluation('p', input), /reported/);
  assert.deepEqual(await readFile(target), before);
});

test('competing expected revisions commit once and conflict with current identity', async () => {
  const { store, root } = await setup();
  const input = await request(store);
  const second = structuredClone(input); second.coordination.operationId = 'second';
  const results = await Promise.allSettled([store.coordinateEvaluation('p', input), new ProjectStore(root).coordinateEvaluation('p', second)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const conflict = results.find(r => r.status === 'rejected').reason;
  assert.equal(conflict.code, 'REVISION_CONFLICT'); assert.equal(conflict.identity.revision, input.coordination.expectedRevision + 1);
});

for (const operationId of ['op', '__proto__', 'constructor']) test(`restart replay preserves historical response and bytes for ${operationId}`, async () => {
  const { store, root, target } = await setup(); const input = await request(store, operationId);
  const result = await store.coordinateEvaluation('p', input);
  await store.addObservation('p', { observation: 'later state' });
  const before = await readFile(target);
  const replay = await new ProjectStore(root).coordinateEvaluation('p', input);
  assert.deepEqual(replay, { ...result, replayed: true }); assert.deepEqual(await readFile(target), before);
  const different = structuredClone(input); different.summary = 'different';
  await assert.rejects(store.coordinateEvaluation('p', different), /operation.*payload|digest/i);
});

test('noCommit does not advance revision and rejects speculative mutation', async () => {
  const { store, project, target } = await setup(); const before = await readFile(target);
  const reply = await store.transact('p', (_project, { noCommit }) => noCommit({ historical: true }));
  assert.equal(reply.project.revision, project.revision); assert.deepEqual(reply.result, { historical: true });
  assert.deepEqual(await readFile(target), before);
  await assert.rejects(store.transact('p', (project, { noCommit }) => { project.goal = 'speculative'; return noCommit(null); }), /noCommit.*mutat/i);
  assert.deepEqual(await readFile(target), before);
});

test('only explicit supported criteria recommend completion; duplicates share one declaration', async () => {
  const { store } = await setup(['passes', 'passes']); const { getCompletionState } = await core();
  assert.equal(getCompletionState(await store.getProject('p')).recommended, false);
  const result = await store.coordinateEvaluation('p', await request(store));
  assert.equal(result.completion.recommended, true); assert.equal(result.completion.assessmentSource, 'reported');
  assert.equal((await store.getProject('p')).coordination.criteria.length, 1);
});

test('false and unevaluated criteria never pass; bare verified outcome cannot satisfy criteria', async () => {
  const { store } = await setup(['passes', 'second']);
  const result = await store.coordinateEvaluation('p', await request(store, 'false', { criteriaUpdates: [{ goalId: 'goal-root', criterion: 'passes', satisfied: false, evidenceIds: ['e1'] }] }));
  assert.equal(result.completion.recommended, false); assert.equal(result.completion.missingCriteria.length, 2);
  assert.equal((await store.getProject('p')).coordination.criteria[0].satisfied, false);
  const bare = await store.coordinateEvaluation('p', await request(store, 'bare', { criteriaUpdates: [] }));
  assert.equal(bare.completion.recommended, false);
});

test('completion refuses absent criteria, missing/invalid/stale evidence, blockers and contradictions', async () => {
  const { getCompletionState } = await core();
  const { store: empty } = await setup([]); assert.equal(getCompletionState(await empty.getProject('p')).recommended, false);
  const { store } = await setup();
  await assert.rejects(store.coordinateEvaluation('p', await request(store, 'missing', { evidenceRecords: [] })), /evidence/i);
  await assert.rejects(store.coordinateEvaluation('p', await request(store, 'invalid', { evidenceRecords: [evidence({ dependencyIds: [] })] })), /Dependency IDs/);
  const stale = await store.coordinateEvaluation('p', await request(store, 'stale', { evidenceRecords: [evidence({ freshness: 'stale' })] }));
  assert.equal(stale.completion.recommended, false);
  await store.updateGoal('p', 'goal-root', { status: 'blocked' });
  const blocked = await store.coordinateEvaluation('p', await request(store, 'blocked'));
  assert.equal(blocked.completion.recommended, false); assert.ok(blocked.completion.blockers.length);
  await store.addClaim('p', { statement: 'Failure', status: 'contradicted', counterEvidenceIds: ['e1'] });
  const state = getCompletionState(await store.getProject('p')); assert.equal(state.recommended, false); assert.ok(state.contradictions.length);
});

test('invalidation, evidence replacement under same ID and changed criteria revoke old assessments', async () => {
  const { store } = await setup(); const { getCompletionState } = await core();
  await store.coordinateEvaluation('p', await request(store));
  await store.upsertEvidenceRecord('p', evidence({ result: { passed: false } }));
  assert.equal(getCompletionState(await store.getProject('p')).recommended, false);
  await store.coordinateEvaluation('p', await request(store, 'reassess'));
  await store.invalidateEvidence('p', ['source']);
  assert.equal(getCompletionState(await store.getProject('p')).recommended, false);
  await store.coordinateEvaluation('p', await request(store, 'fresh'));
  await store.updateGoal('p', 'goal-root', { successCriteria: ['passes', 'new'] });
  const completion = getCompletionState(await store.getProject('p'));
  assert.equal(completion.recommended, false); assert.equal(completion.missingCriteria.length, 2);
});

test('reset replaces epoch and rejects old operation replay', async () => {
  const { store } = await setup(); const { getStateIdentity } = await core(); const input = await request(store);
  await store.coordinateEvaluation('p', input);
  const reset = await store.initializeProject({ projectId: 'p', goal: 'Again', successCriteria: ['passes'] });
  assert.notEqual(getStateIdentity(reset).epoch, input.coordination.stateEpoch);
  await assert.rejects(store.coordinateEvaluation('p', input), /epoch|generation/i);
});

test('strict canonical digest rejects getters and non-JSON and replays reordered payload keys', async () => {
  const { store } = await setup(); const input = await request(store);
  let invoked = false; const unsafe = { ...input }; Object.defineProperty(unsafe, 'summary', { enumerable: true, get() { invoked = true; return 'bad'; } });
  await assert.rejects(store.coordinateEvaluation('p', unsafe), /data properties|JSON/i); assert.equal(invoked, false);
  await assert.rejects(store.coordinateEvaluation('p', { ...input, extra: undefined }), /JSON/i);
  const original = await store.coordinateEvaluation('p', input);
  const reordered = Object.fromEntries(Object.entries(input).reverse());
  assert.deepEqual(await store.coordinateEvaluation('p', reordered), { ...original, replayed: true });
});

test('all requested mappings are validated and unrelated goals/claims retain their verdicts', async () => {
  const { store, target } = await setup();
  const other = await store.addGoal('p', { title: 'Other', successCriteria: ['other'] });
  const claim = await store.addClaim('p', { statement: 'Unmapped', status: 'unknown' });
  const input = await request(store, 'unknown', { criteriaUpdates: [{ goalId: other.id, criterion: 'absent', satisfied: true, evidenceIds: ['e1'] }] });
  const before = await readFile(target);
  await assert.rejects(store.coordinateEvaluation('p', input), /Unknown.*mapping/); assert.deepEqual(await readFile(target), before);
  await store.coordinateEvaluation('p', await request(store, 'explicit'));
  const state = await store.getProject('p');
  assert.equal(state.goalGraph.find(goal => goal.id === other.id).status, 'pending');
  assert.equal(state.claims.find(item => item.id === claim.id).status, 'unknown');
  await assert.rejects(store.coordinateEvaluation('p', await request(store, 'badClaim', { claimUpdates: [{ claimId: 'absent', status: 'known', evidenceIds: ['e1'] }] })), /Unknown claim/);
});

test('duplicate evidence IDs cannot certify criteria and all reference revisions describe the committed state', async () => {
  const { store } = await setup();
  const input = await request(store, 'ambiguous', { evidenceRecords: [evidence(), evidence({ target: 'different' })] });
  await assert.rejects(store.coordinateEvaluation('p', input), /ambiguous/);
  const committed = await store.coordinateEvaluation('p', await request(store, 'refs'));
  const state = await store.getProject('p');
  assert.equal(committed.evaluation.revision, state.evaluations[0].revision);
  assert.equal(committed.identity.revision, state.revision);
  const ref = committed.refs.find(ref => ref.kind === 'evidence');
  assert.deepEqual(ref, { projectId: 'p', epoch: state.coordination.epoch, kind: 'evidence', id: state.efficiency.evidenceCache[0].key, revision: state.efficiency.evidenceCache[0].revision });
});

test('fused changed dependencies revoke assessments and unresolved dependency goals block completion', async () => {
  const { store } = await setup();
  await store.coordinateEvaluation('p', await request(store));
  const invalidated = await store.coordinateEvaluation('p', await request(store, 'changed', { evidenceRecords: [], criteriaUpdates: [], changedDependencyIds: ['source'] }));
  assert.equal(invalidated.completion.recommended, false);
  const dependency = await store.addGoal('p', { title: 'Dependency', successCriteria: ['ready'] });
  await store.updateGoal('p', 'goal-root', { dependencies: [dependency.id] });
  const blocked = await store.coordinateEvaluation('p', await request(store, 'dependency'));
  assert.equal(blocked.completion.recommended, false);
  assert.ok(blocked.completion.blockers.some(blocker => blocker.dependencyId === dependency.id));
});

test('inconclusive or partial evaluations cannot recommend completion despite reported satisfied criteria', async () => {
  for (const outcome of ['inconclusive', 'partially_verified']) {
    const { store } = await setup(); const input = await request(store); input.outcome = outcome;
    const result = await store.coordinateEvaluation('p', input);
    assert.equal(result.completion.recommended, false); assert.ok(result.completion.uncertainties.length);
  }
});

test('legacy state identities are deterministic and different creation identities differ', async () => {
  const { getStateIdentity } = await core();
  const legacy = { projectId: 'old', createdAt: '2020-01-01', revision: 0 };
  assert.deepEqual(getStateIdentity(legacy), getStateIdentity(structuredClone(legacy)));
  assert.notEqual(getStateIdentity(legacy).epoch, getStateIdentity({ ...legacy, createdAt: '2021-01-01' }).epoch);
});

test('removing and restoring declared criteria cannot resurrect an earlier assessment', async () => {
  const { store } = await setup(); const { getCompletionState } = await core();
  await store.coordinateEvaluation('p', await request(store));
  await store.updateGoal('p', 'goal-root', { successCriteria: ['different'] });
  await store.updateGoal('p', 'goal-root', { successCriteria: ['passes'] });
  assert.equal(getCompletionState(await store.getProject('p')).recommended, false);
});

test('fusion updates only mapped goal statuses when another goal depends on the mapped one', async () => {
  const { store } = await setup();
  const dependent = await store.addGoal('p', { title: 'Later work', successCriteria: ['done'], dependencies: ['goal-root'] });
  assert.equal(dependent.status, 'blocked');
  await store.coordinateEvaluation('p', await request(store));
  const state = await store.getProject('p');
  assert.equal(state.goalGraph.find(goal => goal.id === dependent.id).status, 'blocked');
});

test('legacy MCP initialization omits coordination while store and full state preserve fresh epoch', async () => {
  const { store, project, root } = await setup(); const { getStateIdentity } = await core();
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(project)), 'coordination'), true);
  assert.deepEqual(getStateIdentity(project), getStateIdentity(await store.getProject('p')));
  const script = `const { dispatch } = await import(process.argv[1]);
    const init = await dispatch({ method: 'tools/call', params: { name: 'adaptive_initialize_project', arguments: { projectId: 'wire', goal: 'Legacy response' } } });
    const full = await dispatch({ method: 'tools/call', params: { name: 'adaptive_get_state', arguments: { projectId: 'wire' } } });
    process.stdout.write(JSON.stringify({ init, full }));`;
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, new URL('../server/mcp-server.mjs', import.meta.url).href],
    { env: { ...process.env, ASTRA_PROJECT_FORGE_DATA_DIR: root } });
  const { init, full } = JSON.parse(stdout);
  assert.equal(init.isError, undefined); assert.equal(full.isError, undefined);
  assert.equal(Object.hasOwn(init.structuredContent.project, 'coordination'), false);
  assert.equal(Object.hasOwn(full.structuredContent.project, 'coordination'), true);
  assert.match(full.structuredContent.project.coordination.epoch, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(getStateIdentity(full.structuredContent.project), getStateIdentity(await store.getProject('wire')));
});

// Replacing a claim's independently assessed evidence must not inherit its verdict.
test('known claim support pins assessed evidence across replacement, metadata writes, restart and explicit reassessment', async () => {
  const { store, root, target } = await setup(); const { getCompletionState } = await core();
  const claim = await store.addClaim('p', { statement: 'Independent security check passes', status: 'unknown' });
  const security = evidence({ evidenceId: 'security', target: 'security', dependencies: ['security:v1'], dependencyIds: ['security'] });
  const input = await request(store, 'support', { evidenceRecords: [evidence(), security],
    claimUpdates: [{ claimId: claim.id, status: 'known', evidenceIds: ['security'] }] });
  const receipt = await store.coordinateEvaluation('p', input);
  assert.equal(receipt.completion.recommended, true);
  await store.upsertEvidenceRecord('p', { ...security, result: { passed: false } });
  const restarted = new ProjectStore(root);
  const current = async expected => {
    const completion = getCompletionState(await restarted.getProject('p'));
    assert.deepEqual(completion.missingCriteria, [], 'separate criterion support is unchanged');
    assert.equal(completion.recommended, expected);
    const capsule = await restarted.getDecisionCapsule('p');
    assert.deepEqual(capsule.completion, completion);
    if (!expected) assert.ok(completion.uncertainties.some(item => item.claimId === claim.id));
  };
  await current(false);
  await restarted.updateClaim('p', claim.id, { confidence: 0.9 });
  await restarted.addObservation('p', { observation: 'Unrelated write' });
  await current(false);
  await restarted.coordinateEvaluation('p', await request(restarted, 'metadata', { evidenceRecords: [], criteriaUpdates: [],
    claimUpdates: [{ claimId: claim.id, confidence: 0.8 }] }));
  await current(false);
  const beforeReplay = await readFile(target);
  assert.deepEqual(await restarted.coordinateEvaluation('p', input), { ...receipt, replayed: true });
  assert.deepEqual(await readFile(target), beforeReplay);
  await restarted.coordinateEvaluation('p', await request(restarted, 'reassess-security', { evidenceRecords: [], criteriaUpdates: [],
    claimUpdates: [{ claimId: claim.id, status: 'known', evidenceIds: ['security'] }] }));
  await current(true); // Explicit assessment, never an interpretation of result.passed.
  await restarted.invalidateEvidence('p', ['security']);
  await current(false);
  await restarted.upsertEvidenceRecord('p', { ...security, result: { passed: false } });
  await current(false); // Restoring identical fresh content cannot revive the old assessment.
  await restarted.updateClaim('p', claim.id, { status: 'known', evidenceIds: ['security'] });
  await current(true);
  await restarted.updateClaim('p', claim.id, { statement: 'A different assertion' });
  await current(false);
  await restarted.updateClaim('p', claim.id, { confidence: 1 });
  await current(false);
});

test('legacy known claim creation captures current support without changing legacy validation', async () => {
  const { store } = await setup(); const { getCompletionState } = await core();
  await store.coordinateEvaluation('p', await request(store));
  await store.upsertEvidenceRecord('p', evidence({ evidenceId: 'separate', target: 'separate' }));
  await store.addClaim('p', { statement: 'Legacy supported claim', status: 'known', evidenceIds: ['separate'] });
  assert.equal(getCompletionState(await store.getProject('p')).recommended, true);
  await store.upsertEvidenceRecord('p', evidence({ evidenceId: 'separate', target: 'separate', result: { new: true } }));
  assert.equal(getCompletionState(await store.getProject('p')).recommended, false);
  await store.addClaim('p', { statement: 'External evidence remains accepted', status: 'known', evidenceIds: ['external-id'] });
});

for (const mode of ['legacy', 'fused']) for (const [outcome, missingCriteria, collection] of [
  ['falsified', [], 'contradictions'], ['blocked', [], 'blockers'],
  ['inconclusive', [], 'uncertainties'], ['partially_verified', [], 'uncertainties'],
  ['verified', ['unresolved audit'], 'uncertainties'],
]) test(`${mode} ${outcome} evaluation scope survives another goal and allows same-goal recovery`, async () => {
  const { store } = await setup(); const { getCompletionState } = await core();
  const other = await store.addGoal('p', { title: 'Other goal', successCriteria: ['other'] });
  const failedPlan = await store.addPlan('p', { goalId: 'goal-root', action: 'First attempt', why: 'Verify' });
  const correctedPlan = await store.addPlan('p', { goalId: 'goal-root', action: 'Corrected strategy', why: 'Recover' });
  await store.coordinateEvaluation('p', await request(store, 'both', { criteriaUpdates: [
    { goalId: 'goal-root', criterion: 'passes', satisfied: true, evidenceIds: ['e1'] },
    { goalId: other.id, criterion: 'other', satisfied: true, evidenceIds: ['e1'] },
  ] }));
  let counter = 0;
  const evaluate = async fields => {
    if (mode === 'legacy') return store.addEvaluation('p', { summary: 'Reported assessment', ...fields });
    const input = await request(store, `scope-${counter++}`, { evidenceRecords: [], criteriaUpdates: [] });
    return (await store.coordinateEvaluation('p', { ...input, ...fields })).evaluation;
  };
  const failure = await evaluate({ planId: failedPlan.id, outcome, missingCriteria });
  await evaluate({ goalId: other.id, outcome: 'verified', evidenceIds: ['e1'] });
  const completion = getCompletionState(await store.getProject('p'));
  assert.equal(completion.recommended, false);
  assert.ok(completion[collection].some(item => item.evaluationId === failure.id));
  const capsule = await store.getDecisionCapsule('p', { cursor: (await store.getDecisionCapsule('p')).identity, maxItems: 1 });
  assert.deepEqual(capsule.completion, completion);
  assert.ok(capsule.refs.some(ref => ref.kind === 'evaluation' && ref.id === failure.id));
  await evaluate({ planId: correctedPlan.id, outcome: 'verified', evidenceIds: ['e1'] });
  assert.equal(getCompletionState(await store.getProject('p')).recommended, true);
});

test('unscoped and conflicting evaluation scope cannot clear another goal failure', async () => {
  const { store } = await setup(); const { getCompletionState } = await core();
  const other = await store.addGoal('p', { title: 'Other goal', successCriteria: ['other'] });
  const plan = await store.addPlan('p', { goalId: other.id, action: 'Other work', why: 'Check' });
  await store.coordinateEvaluation('p', await request(store, 'both', { criteriaUpdates: [
    { goalId: 'goal-root', criterion: 'passes', satisfied: true, evidenceIds: ['e1'] },
    { goalId: other.id, criterion: 'other', satisfied: true, evidenceIds: ['e1'] },
  ] }));
  const failure = await store.addEvaluation('p', { goalId: 'goal-root', outcome: 'falsified', summary: 'Root failed' });
  for (const fields of [{}, { goalId: 'goal-root', planId: plan.id }]) {
    await store.addEvaluation('p', { ...fields, outcome: 'verified', summary: 'Ambiguous scope' });
    assert.ok(getCompletionState(await store.getProject('p')).contradictions.some(item => item.evaluationId === failure.id));
  }
  const unknown = await store.addEvaluation('p', { outcome: 'inconclusive', summary: 'Unscoped uncertainty' });
  await store.addEvaluation('p', { goalId: 'goal-root', outcome: 'verified', summary: 'Root recovered' });
  await store.addEvaluation('p', { goalId: other.id, outcome: 'verified', summary: 'Other recovered' });
  const completion = getCompletionState(await store.getProject('p'));
  assert.equal(completion.recommended, false);
  assert.ok(completion.uncertainties.some(item => item.evaluationId === unknown.id));
});

test('only a new complete supported fused project reassessment resolves ambiguous history; replay preserves newer failures', async () => {
  const { store, root, target } = await setup(); const { getCompletionState } = await core();
  const other = await store.addGoal('p', { title: 'Other goal', successCriteria: ['other'] });
  const plan = await store.addPlan('p', { goalId: other.id, action: 'Other work', why: 'Check' });
  const criteriaUpdates = [
    { goalId: 'goal-root', criterion: 'passes', satisfied: true, evidenceIds: ['e1'] },
    { goalId: other.id, criterion: 'other', satisfied: true, evidenceIds: ['e1'] },
  ];
  await store.coordinateEvaluation('p', await request(store, 'initial-project', { criteriaUpdates }));
  const unscoped = await store.addEvaluation('p', { outcome: 'inconclusive', summary: 'Unscoped uncertainty' });
  const ambiguous = await store.addEvaluation('p', { goalId: 'goal-root', planId: plan.id, outcome: 'falsified', summary: 'Conflicting scope failure' });
  for (const [name, patch, evaluation] of [
    ['partial', { criteriaUpdates: criteriaUpdates.slice(0, 1) }, {}],
    ['old-assessments', { criteriaUpdates: [] }, {}],
    ['stale', { criteriaUpdates, evidenceRecords: [evidence({ freshness: 'stale' })] }, {}],
    ['false', { criteriaUpdates: criteriaUpdates.map(item => ({ ...item, satisfied: false })) }, {}],
    ['missing', { criteriaUpdates }, { missingCriteria: ['unresolved check'] }],
    ['inconclusive', { criteriaUpdates }, { outcome: 'inconclusive' }],
  ]) {
    const result = await store.coordinateEvaluation('p', { ...await request(store, name, patch), ...evaluation });
    assert.equal(result.evaluation.assessmentScope, undefined, name);
    assert.equal(result.completion.recommended, false, name);
    assert.ok(result.completion.uncertainties.some(item => item.evaluationId === unscoped.id), name);
    assert.ok(result.completion.contradictions.some(item => item.evaluationId === ambiguous.id), name);
  }
  const recovery = await request(store, 'explicit-project', { criteriaUpdates });
  const result = await store.coordinateEvaluation('p', recovery);
  assert.equal(result.evaluation.assessmentScope, 'project');
  assert.equal(result.completion.recommended, true);
  assert.equal((await new ProjectStore(root).getDecisionCapsule('p')).completion.recommended, true);
  const later = await store.addEvaluation('p', { outcome: 'blocked', summary: 'New unscoped failure' });
  const before = await readFile(target);
  assert.deepEqual(await store.coordinateEvaluation('p', recovery), { ...result, replayed: true });
  assert.deepEqual(await readFile(target), before);
  assert.ok(getCompletionState(await store.getProject('p')).blockers.some(item => item.evaluationId === later.id));
  const checkpoint = await store.addCheckpoint('p', { summary: 'Outstanding uncertainty', remainingUnknowns: ['External permission'] });
  const rerun = await store.coordinateEvaluation('p', await request(store, 'project-with-blocker', { criteriaUpdates }));
  assert.equal(rerun.evaluation.assessmentScope, 'project');
  assert.equal(rerun.completion.recommended, false);
  assert.ok(rerun.completion.uncertainties.some(item => item.checkpointId === checkpoint.id));
  await store.addGoal('p', { title: 'Undeclared requirements', successCriteria: [] });
  const incomplete = await store.coordinateEvaluation('p', await request(store, 'no-vacuous-scope', { criteriaUpdates }));
  assert.equal(incomplete.evaluation.assessmentScope, undefined, 'goals without criteria prevent project scope');
  assert.equal(incomplete.completion.recommended, false);
});
