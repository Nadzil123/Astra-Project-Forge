import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../server/state-store.mjs';
import { getStateIdentity, getCompletionState } from '../server/coordination-core.mjs';

const evidence = (patch = {}) => ({ evidenceId: 'e1', kind: 'test', target: 'source',
  dependencies: ['v1'], dependencyIds: ['source'], freshness: 'fresh', result: { passed: true }, ...patch });
async function api() {
  assert.equal(typeof ProjectStore.prototype.getDecisionCapsule, 'function', 'decision capsule reader must exist');
  return import('../server/decision-capsule.mjs');
}
async function setup(t, patch = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-capsule-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ProjectStore(root);
  await store.initializeProject({ projectId: 'p', goal: 'Complete safely', successCriteria: ['passes'],
    constraints: ['Do not expose secrets'], ...patch });
  const target = path.join(root, (await readdir(root)).find(name => name.endsWith('.json')));
  return { store, target };
}

// Break caught: letting an unchanged delta erase binding context, contrary
// evidence, required criteria, or unresolved completion checks.
test('unchanged cursors preserve hard constraints, counter-evidence and unmet criteria', async t => {
  const { store } = await setup(t); await api();
  const proof = await store.upsertEvidenceRecord('p', evidence());
  const counter = await store.upsertEvidenceRecord('p', evidence({ evidenceId: 'counter', target: 'counter', result: { passed: false } }));
  await store.addClaim('p', { statement: 'It passes', status: 'contradicted', evidenceIds: ['e1'], counterEvidenceIds: ['counter'] });
  const project = await store.getProject('p');
  const capsule = await store.getDecisionCapsule('p', { cursor: getStateIdentity(project), maxItems: 1 });
  assert.deepEqual(capsule.constraints, ['Do not expose secrets']);
  assert.equal(capsule.goal.id, 'goal-root'); assert.equal(capsule.unmetCriteria[0].criterion, 'passes');
  assert.equal(capsule.claims[0].status, 'contradicted');
  assert.equal(capsule.claims[0].evidenceRefs[0].id, proof.key);
  assert.equal(capsule.claims[0].counterEvidenceRefs[0].id, counter.key);
  assert.equal(capsule.changedEvidence.length, 0); assert.equal(capsule.completion.recommended, false);
});

test('claims retain known, inferred, unknown and contradicted statuses with evidence mappings', async t => {
  const { store } = await setup(t); await api();
  const proof = await store.upsertEvidenceRecord('p', evidence());
  for (const status of ['known', 'inferred', 'unknown', 'contradicted']) {
    await store.addClaim('p', { statement: status, status, evidenceIds: ['e1'], counterEvidenceIds: status === 'contradicted' ? ['e1'] : [] });
  }
  const capsule = await store.getDecisionCapsule('p', { maxItems: 1 });
  assert.deepEqual(capsule.claims.map(claim => claim.status), ['known', 'inferred', 'unknown', 'contradicted']);
  assert.ok(capsule.claims.every(claim => claim.evidenceRefs[0].id === proof.key));
  assert.equal(capsule.claims[3].counterEvidenceRefs[0].id, proof.key);
});

test('malformed, foreign and future cursors give explicit resync guidance and current mandatory context', async t => {
  const { store } = await setup(t); await api(); const identity = getStateIdentity(await store.getProject('p'));
  for (const cursor of [null, {}, { ...identity, revision: -1 }, { ...identity, revision: identity.revision + 1 },
    { ...identity, epoch: 'old' }, { ...identity, projectId: 'other' }, { ...identity, revision: '1' }]) {
    const capsule = await store.getDecisionCapsule('p', { cursor });
    assert.ok(capsule.expansion.resync?.reason); assert.deepEqual(capsule.expansion.resync.identity, identity);
    assert.equal(capsule.incomplete, true); assert.equal(capsule.expansion.fullContext.detail, 'full');
    assert.equal(capsule.goal.id, 'goal-root'); assert.equal(capsule.constraints.length, 1);
  }
});

// Break caught: interpreting no risk evidence as safety or letting budget
// limits discard mandatory requirements and strategy failures.
test('necessary risk with no evidence remains unknown and prevents completion', async t => {
  const { store } = await setup(t); await api();
  const plan = await store.addPlan('p', { goalId: 'goal-root', action: 'Ship', why: 'Deliver', risk: 'high' });
  const identity = getStateIdentity(await store.getProject('p'));
  await store.coordinateEvaluation('p', { outcome: 'verified', summary: 'Criteria reported satisfied', evidenceIds: ['e1'],
    coordination: { operationId: 'complete', expectedRevision: identity.revision, stateEpoch: identity.epoch,
      evidenceRecords: [evidence()], criteriaUpdates: [{ goalId: 'goal-root', criterion: 'passes', satisfied: true, evidenceIds: ['e1'] }] } });
  const capsule = await store.getDecisionCapsule('p');
  assert.equal(capsule.risk[0].planId, plan.id); assert.equal(capsule.risk[0].status, 'unknown');
  assert.deepEqual(capsule.risk[0].evidenceRefs, []); assert.equal(capsule.completion.recommended, false);
  assert.equal(getCompletionState(await store.getProject('p')).recommended, false);
});

test('large constraint and failed-strategy sets remain mandatory even under maxItems one', async t => {
  const constraints = Array.from({ length: 35 }, (_, index) => `Hard rule ${index}`);
  const { store } = await setup(t, { constraints }); await api();
  for (let index = 0; index < 3; index++) {
    const plan = await store.addPlan('p', { goalId: 'goal-root', action: `Attempt ${index}`, why: 'Try', strategyKey: `s${index}` });
    await store.addEvaluation('p', { planId: plan.id, outcome: 'blocked', summary: 'Failed' });
  }
  const capsule = await store.getDecisionCapsule('p', { cursor: getStateIdentity(await store.getProject('p')), maxItems: 1 });
  assert.deepEqual(capsule.constraints, constraints); assert.equal(capsule.failedStrategies.length, 3);
  assert.ok(capsule.blockers.length); assert.equal(capsule.completion.recommended, false);
});

// Break caught: dropping invalidated or removed evidence from client delta,
// silently truncating optional details, or claiming no change without a cursor.
test('optional evidence changes are bounded with omitted refs and known-reference deletion status', async t => {
  const { store } = await setup(t); await api();
  await store.upsertEvidenceRecord('p', evidence());
  await store.upsertEvidenceRecord('p', evidence({ evidenceId: 'e2', target: 'second' }));
  await store.upsertEvidenceRecord('p', evidence({ evidenceId: 'e3', target: 'third' }));
  const project = await store.getProject('p');
  const initial = await store.getDecisionCapsule('p', { maxItems: 1 });
  assert.equal(initial.changedEvidence.length, 1); assert.equal(initial.expansion.omittedRefs.length, 2);
  assert.equal(initial.incomplete, true);
  const cursor = getStateIdentity(project); const knownRefs = initial.refs.filter(ref => ref.kind === 'evidence');
  await store.invalidateEvidence('p', ['source']);
  const updated = await store.getDecisionCapsule('p', { cursor, knownRefs, maxItems: 20 });
  assert.equal(updated.changedEvidence.length, 3); assert.ok(updated.changedEvidence.every(item => item.freshness === 'stale'));
  assert.ok(updated.expansion.referenceStatuses.every(entry => entry.status === 'stale'));
  await store.transact('p', state => { state.efficiency.evidenceCache = []; });
  const removed = await store.getDecisionCapsule('p', { cursor, knownRefs });
  assert.deepEqual(removed.expansion.referenceStatuses.map(entry => entry.status), ['not_found', 'not_found', 'not_found']);
});

test('missing evidence mapping is explicit and no criteria or unchanged cursor can recommend completion', async t => {
  const { store } = await setup(t, { successCriteria: [] }); await api();
  await store.addClaim('p', { statement: 'Unsubstantiated', status: 'known', evidenceIds: ['missing'] });
  const capsule = await store.getDecisionCapsule('p', { cursor: getStateIdentity(await store.getProject('p')) });
  assert.equal(capsule.completion.recommended, false); assert.ok(capsule.uncertainty.length);
  assert.deepEqual(capsule.claims[0].missingEvidenceIds, ['missing']); assert.deepEqual(capsule.claims[0].evidenceRefs, []);
  assert.equal(capsule.incomplete, true);
});

test('capsule reads leave bytes unchanged and full expansion recovers each stored record', async t => {
  const { store, target } = await setup(t); await api();
  await store.addObservation('p', { observation: 'Useful context', evidence: 'provenance detail' });
  const project = await store.getProject('p'); const before = await readFile(target);
  const capsule = await store.getDecisionCapsule('p');
  assert.deepEqual(await readFile(target), before);
  const expanded = await store.getReferences('p', capsule.refs);
  assert.ok(expanded.references.every(entry => entry.status === 'unchanged'));
  assert.deepEqual(expanded.references.find(entry => entry.ref.kind === 'observation').record, project.observations[0]);
  assert.deepEqual(await readFile(target), before);
});

test('explicit goal selection resolves that goal and unknown goals cannot masquerade as current context', async t => {
  const { store } = await setup(t); await api();
  const other = await store.addGoal('p', { title: 'Other', successCriteria: ['other done'] });
  assert.equal((await store.getDecisionCapsule('p', { goalId: other.id })).goal.id, other.id);
  await assert.rejects(store.getDecisionCapsule('p', { goalId: 'absent' }), /Goal not found/);
});

// Break caught: an implementation that always disables completion or drops
// criterion evidence/provenance rather than reflecting the coordination core.
test('supported explicit criteria retain completion and their evidence is expandable', async t => {
  const { store } = await setup(t); await api();
  const identity = getStateIdentity(await store.getProject('p'));
  await store.coordinateEvaluation('p', { outcome: 'verified', summary: 'Reported pass', evidenceIds: ['e1'],
    coordination: { operationId: 'pass', expectedRevision: identity.revision, stateEpoch: identity.epoch,
      evidenceRecords: [evidence({ provenance: { source: 'reported', reference: 'runner' } })],
      criteriaUpdates: [{ goalId: 'goal-root', criterion: 'passes', satisfied: true, evidenceIds: ['e1'] }] } });
  const capsule = await store.getDecisionCapsule('p', { cursor: getStateIdentity(await store.getProject('p')) });
  assert.equal(capsule.completion.recommended, true); assert.deepEqual(capsule.unmetCriteria, []);
  const ref = capsule.refs.find(ref => ref.kind === 'evidence');
  assert.equal((await store.getReferences('p', [ref])).references[0].record.provenance.reference, 'runner');
});

// Break caught: treating ambiguous evidenceId metadata as one authoritative
// cache identity, or failing to flag a missing counter-evidence mapping.
test('ambiguous supporting evidence and missing counter-evidence stay explicit', async t => {
  const { store } = await setup(t); await api();
  await store.upsertEvidenceRecord('p', evidence());
  await store.upsertEvidenceRecord('p', evidence({ target: 'second cache identity' }));
  await store.addClaim('p', { statement: 'Known?', status: 'known', evidenceIds: ['e1'], counterEvidenceIds: ['missing'] });
  const capsule = await store.getDecisionCapsule('p');
  assert.equal(capsule.claims[0].evidenceRefs.length, 2);
  assert.notEqual(capsule.claims[0].evidenceRefs[0].id, capsule.claims[0].evidenceRefs[1].id);
  assert.deepEqual(capsule.claims[0].ambiguousEvidenceIds, ['e1']);
  assert.deepEqual(capsule.claims[0].missingEvidenceIds, ['missing']);
  assert.equal(capsule.completion.recommended, false); assert.equal(capsule.incomplete, true);
});

// Break caught: independently treating the same unresolved plan as complete in
// the core, or promoting a bare plan outcome without mapped current criteria.
test('core and capsule share conservative reported plan-risk verification and invalidation', async t => {
  const { store } = await setup(t); await api();
  const plan = await store.addPlan('p', { goalId: 'goal-root', action: 'Ship', why: 'Deliver', risk: 'high' });
  const riskEvidence = evidence({ evidenceId: 'risk-proof', target: 'risk-check', dependencies: ['risk-v1'], dependencyIds: ['risk-check'] });
  async function evaluate(operationId, outcome = 'verified', patch = {}) {
    const identity = getStateIdentity(await store.getProject('p'));
    return store.coordinateEvaluation('p', { planId: plan.id, goalId: 'goal-root', outcome, summary: 'Reported plan verification',
      evidenceIds: ['risk-proof'], ...patch,
      coordination: { operationId, expectedRevision: identity.revision, stateEpoch: identity.epoch,
        evidenceRecords: [evidence(), riskEvidence], criteriaUpdates: [] } });
  }
  const unsupported = await evaluate('unsupported');
  assert.equal(unsupported.completion.risk[0].status, 'unknown');
  assert.equal((await store.getDecisionCapsule('p')).risk[0].status, 'unknown');
  const identity = getStateIdentity(await store.getProject('p'));
  const verified = await store.coordinateEvaluation('p', { planId: plan.id, goalId: 'goal-root', outcome: 'verified',
    summary: 'Explicit reported verification', evidenceIds: ['risk-proof'], coordination: {
      operationId: 'verified', expectedRevision: identity.revision, stateEpoch: identity.epoch,
      criteriaUpdates: [{ goalId: 'goal-root', criterion: 'passes', satisfied: true, evidenceIds: ['e1'] }] } });
  const capsule = await store.getDecisionCapsule('p');
  assert.equal(verified.completion.recommended, true); assert.equal(capsule.completion.recommended, true);
  assert.equal(capsule.risk[0].status, 'reported_verified'); assert.equal(capsule.risk[0].risk, 'high');
  assert.equal(capsule.risk[0].assessmentSource, 'reported'); assert.equal(capsule.risk[0].evidenceRefs.length, 1);
  assert.equal(capsule.risk[0].evaluationRef.id, verified.evaluation.id);
  await store.invalidateEvidence('p', ['risk-check']);
  const invalidated = await store.getDecisionCapsule('p');
  assert.equal(invalidated.risk[0].status, 'unknown'); assert.equal(invalidated.completion.recommended, false);
  assert.equal(getCompletionState(await store.getProject('p')).recommended, false);
  const missing = await evaluate('missing', 'verified', { missingCriteria: ['risk uncertain'] });
  assert.equal(missing.completion.risk[0].status, 'unknown');
  const superseded = await evaluate('later', 'inconclusive');
  assert.equal(superseded.completion.risk[0].status, 'unknown');
});

// I1: changing separate risk evidence under the same key must not borrow the
// old plan evaluation's verdict while its criterion evidence stays supported.
test('fresh risk evidence replacement revokes the old verdict until explicit reevaluation', async t => {
  const { store } = await setup(t); await api();
  const plan = await store.addPlan('p', { goalId: 'goal-root', action: 'Ship', why: 'Deliver', risk: 'high' });
  const riskEvidence = evidence({ evidenceId: 'risk-proof', target: 'risk-check', dependencies: ['risk-v1'], dependencyIds: ['risk-check'] });
  async function evaluate(operationId, records, criteriaUpdates = []) {
    const identity = getStateIdentity(await store.getProject('p'));
    return store.coordinateEvaluation('p', { planId: plan.id, goalId: 'goal-root', outcome: 'verified',
      summary: 'Explicit reported risk verification', evidenceIds: ['risk-proof'], coordination: {
        operationId, expectedRevision: identity.revision, stateEpoch: identity.epoch, evidenceRecords: records, criteriaUpdates } });
  }
  const first = await evaluate('original-risk', [evidence(), riskEvidence],
    [{ goalId: 'goal-root', criterion: 'passes', satisfied: true, evidenceIds: ['e1'] }]);
  assert.equal(first.completion.recommended, true);
  const before = await store.getDecisionCapsule('p');
  const criterionRef = before.refs.find(ref => ref.kind === 'evidence' && ref.id !== before.risk[0].evidenceRefs[0].id);
  const riskRef = before.risk[0].evidenceRefs[0];
  await store.upsertEvidenceRecord('p', { ...riskEvidence, result: { passed: false } });
  const state = await store.getProject('p');
  const core = getCompletionState(state);
  assert.equal(core.risk[0].status, 'unknown'); assert.equal(core.recommended, false);
  assert.deepEqual(core.missingCriteria, [], 'separate criterion evidence remains supported');
  const replaced = await store.getDecisionCapsule('p', { cursor: before.identity, knownRefs: [riskRef, criterionRef] });
  assert.equal(replaced.risk[0].status, 'unknown'); assert.equal(replaced.completion.recommended, false);
  assert.deepEqual(replaced.risk[0].evaluationRef, before.risk[0].evaluationRef);
  assert.deepEqual(replaced.expansion.referenceStatuses.map(entry => entry.status), ['stale', 'unchanged']);
  assert.equal(replaced.changedEvidence[0].result.passed, false);
  const expansion = await store.getReferences('p', [riskRef, criterionRef]);
  assert.equal(expansion.references[0].status, 'stale');
  assert.equal(expansion.references[0].currentRecord.freshness, 'fresh');
  assert.equal(expansion.references[1].status, 'unchanged');
  await store.addObservation('p', { observation: 'Unrelated mutation cannot reverify risk' });
  assert.equal((await store.getDecisionCapsule('p')).risk[0].status, 'unknown');
  const reevaluated = await evaluate('new-risk', [riskEvidence]);
  assert.equal(reevaluated.completion.risk[0].status, 'reported_verified'); assert.equal(reevaluated.completion.recommended, true);
  assert.equal((await store.getDecisionCapsule('p')).completion.recommended, true);
});

// Break caught: losing explicit checkpoint/consolidation uncertainty or an open
// hypothesis when the cursor indicates there are no recent changes.
test('unchanged cursors keep recorded checkpoint, consolidation and hypothesis uncertainty', async t => {
  const { store } = await setup(t); await api();
  const hypothesis = await store.addHypothesis('p', { hypothesis: 'Unknown failure mechanism', test: 'Probe' });
  const checkpoint = await store.addCheckpoint('p', { summary: 'Paused', remainingUnknowns: ['Deployment permissions'] });
  await store.consolidate('p', { verifiedResult: 'Partial progress', remainingUncertainty: ['External dependency'] });
  const capsule = await store.getDecisionCapsule('p', { cursor: getStateIdentity(await store.getProject('p')), maxItems: 1 });
  assert.ok(capsule.uncertainty.some(item => item.checkpointId === checkpoint.id && item.reason === 'Deployment permissions'));
  assert.ok(capsule.uncertainty.some(item => item.reason === 'External dependency'));
  assert.ok(capsule.uncertainty.some(item => item.hypothesisId === hypothesis.id));
});

test('unchanged cursors do not resend historical optional refs but retain mandatory claim refs', async t => {
  const { store } = await setup(t); await api();
  const claim = await store.addClaim('p', { statement: 'Still unknown', status: 'unknown' });
  for (let index = 0; index < 4; index++) await store.addObservation('p', { observation: `Old ${index}` });
  const capsule = await store.getDecisionCapsule('p', { cursor: getStateIdentity(await store.getProject('p')), maxItems: 1 });
  assert.equal(capsule.refs.filter(ref => ref.kind === 'observation').length, 0);
  assert.equal(capsule.refs.filter(ref => ref.kind === 'claim' && ref.id === claim.id).length, 1);
  assert.equal(capsule.expansion.fullContext.detail, 'full');
});

test('current recorded uncertainty vetoes supported criteria until explicitly cleared or resolved', async t => {
  const { store } = await setup(t); await api();
  const identity = getStateIdentity(await store.getProject('p'));
  await store.coordinateEvaluation('p', { outcome: 'verified', summary: 'Reported pass', evidenceIds: ['e1'], coordination: {
    operationId: 'criteria', expectedRevision: identity.revision, stateEpoch: identity.epoch, evidenceRecords: [evidence()],
    criteriaUpdates: [{ goalId: 'goal-root', criterion: 'passes', satisfied: true, evidenceIds: ['e1'] }] } });
  const hypothesis = await store.addHypothesis('p', { hypothesis: 'Unknown cause' });
  const checkpoint = await store.addCheckpoint('p', { summary: 'Pending', remainingUnknowns: ['Unknown permission'] });
  await store.consolidate('p', { verifiedResult: 'Partial', remainingUncertainty: ['Unknown external effect'] });
  const pending = await store.getDecisionCapsule('p');
  assert.equal(getCompletionState(await store.getProject('p')).recommended, false);
  assert.equal(pending.completion.recommended, false);
  assert.equal(pending.uncertainty.find(item => item.checkpointId === checkpoint.id).ref.id, checkpoint.id);
  assert.equal(pending.uncertainty.find(item => item.hypothesisId === hypothesis.id).ref.id, hypothesis.id);
  await store.addCheckpoint('p', { summary: 'Permissions resolved', remainingUnknowns: [] });
  await store.consolidate('p', { verifiedResult: 'External effects resolved', remainingUncertainty: [] });
  assert.equal(getCompletionState(await store.getProject('p')).recommended, false, 'open hypothesis still vetoes');
  await store.addExperiment('p', { hypothesisId: hypothesis.id, action: 'Probe', result: 'Supported', outcome: 'supported' });
  const cleared = await store.getDecisionCapsule('p');
  assert.equal(cleared.completion.recommended, true); assert.equal(getCompletionState(await store.getProject('p')).recommended, true);
  assert.deepEqual(cleared.uncertainty, []);
});

test('capsule known-reference statuses omit record bodies while explicit expansion remains exact', async t => {
  const { store } = await setup(t); await api();
  const proof = await store.upsertEvidenceRecord('p', evidence({ result: { log: 'Detailed verifier output' } }));
  const initial = await store.getDecisionCapsule('p');
  const ref = initial.refs.find(item => item.kind === 'evidence');
  const unchanged = await store.getDecisionCapsule('p', { cursor: initial.identity, knownRefs: [ref] });
  const status = unchanged.expansion.referenceStatuses[0];
  assert.equal(status.status, 'unchanged'); assert.deepEqual(status.ref, ref);
  assert.equal(status.record, undefined); assert.equal(status.currentRecord, undefined);
  assert.equal((await store.getReferences('p', [ref])).references[0].record.result.log, 'Detailed verifier output');
  await store.invalidateEvidence('p', ['source']);
  const updated = await store.getDecisionCapsule('p', { knownRefs: [ref] });
  assert.equal(updated.expansion.referenceStatuses[0].status, 'stale');
  assert.equal(updated.expansion.referenceStatuses[0].currentRecord, undefined);
  assert.ok(updated.expansion.referenceStatuses[0].currentRef.revision > proof.revision);
});
