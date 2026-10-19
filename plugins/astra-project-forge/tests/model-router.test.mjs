import test from 'node:test';
import assert from 'node:assert/strict';
import { routingFixture, supportAllCriteria, addDependencyRisk, addFailure, routingRef } from './helpers/model-routing-fixtures.mjs';
import { createAdvisoryHostAdapter } from '../server/model-host-adapter.mjs';
import { readModelEligibility } from '../server/model-policy.mjs';
import { getCompletionState } from '../server/coordination-core.mjs';
import { policyBudget } from '../server/efficiency-governor.mjs';

const router = await import('../server/model-router.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === new URL('../server/model-router.mjs', import.meta.url).href) return {};
  throw error;
});
function advice(fixture, signals = {}) {
  assert.equal(typeof router.buildModelRoutingSnapshot, 'function', 'missing snapshot feature');
  assert.equal(typeof router.recommendModel, 'function', 'missing advice feature');
  const snapshot = freeze(router.buildModelRoutingSnapshot(fixture.project, fixture.request, signals));
  return router.recommendModel(snapshot, fixture.request, fixture.runtime);
}
function validate(value, options) {
  assert.equal(typeof router.validateModelRoutingRequest, 'function', 'missing canonical validator');
  return router.validateModelRoutingRequest(value, options);
}
function hold(fixture) {
  fixture.project.modelRouting = { version: 1, decisions: [{ id: 'previous', revision: 1,
    workUnitId: 'work-1', sourceIdentity: 'source:v1', advice: { recommendedModel: 'gpt-6-astra',
      hold: { model: 'gpt-6-astra', workUnitId: 'work-1', sourceIdentity: 'source:v1',
        triggerKind: 'dependency_risk', triggerRefs: [routingRef('plan', 'plan-1')] } } }], operations: {} };
  return fixture;
}

function remember(fixture, result = advice(fixture)) {
  fixture.project.modelRouting ??= { version: 1, decisions: [], operations: {} };
  fixture.project.modelRouting.decisions.push({ id: `decision-${fixture.project.modelRouting.decisions.length}`,
    revision: 1, workUnitId: fixture.request.workUnitId, sourceIdentity: fixture.request.sourceIdentity, advice: result });
  return result;
}

function resolveHeldWork(fixture) {
  supportAllCriteria(fixture.project);
  fixture.project.evaluations.push({ id: 'resolved-eval', revision: 2,
    planId: fixture.project.plans[0].id, outcome: 'verified', missingCriteria: [], evidenceIds: ['check-1'] });
}

for (const kind of ['dependency_risk', 'stalled_strategy']) {
  function mixedBenefit() {
    const f = kind === 'dependency_risk' ? addDependencyRisk(routingFixture()) : addFailure(routingFixture());
    const causal = kind === 'dependency_risk' ? routingRef('plan', 'plan-1') : routingRef('failedStrategy', 'failure-1');
    const supporting = routingRef('evidence', f.project.efficiency.evidenceCache[0].key);
    f.request.benefit = { kind, reason: 'Resolve the source-bound contract', refs: [causal, supporting] };
    return { f, causal, supporting };
  }

  test(`F1 ${kind} new hold keeps causal refs and supporting advice evidence`, () => {
    const { f, causal, supporting } = mixedBenefit();
    const result = advice(f);
    assert.equal(result.policyAction, 'ESCALATE_ASTRA');
    assert.deepEqual(result.hold.triggerRefs, [causal]);
    assert.ok(result.evidenceRefs.some(ref => ref.kind === 'evidence' && ref.id === supporting.id));
  });

  test(`F1 ${kind} legacy mixed hold permits supported completion and stable downgrade`, () => {
    const { f, causal, supporting } = mixedBenefit();
    const initial = advice(f);
    initial.hold.triggerRefs = [causal, supporting];
    remember(f, initial);
    const history = JSON.stringify(f.project.modelRouting);
    Object.assign(f.request, { benefit: null, currentModel: 'gpt-6-astra', stableBoundary: true });
    resolveHeldWork(f);
    const snapshot = router.buildModelRoutingSnapshot(f.project, f.request);
    assert.equal(snapshot.completion.recommended, true);
    assert.equal(snapshot.holdResolutionSupported, true);
    assert.equal(advice(f).action, 'COMPLETE');
    const trigger = kind === 'dependency_risk' ? f.project.plans[0] : f.project.efficiency.failedStrategies[0];
    trigger.revision = 2;
    assert.equal(advice(f).action, 'COMPLETE');
    f.project.goalGraph.push({ id: 'goal-2', revision: 1, status: 'active', dependencies: [], successCriteria: ['remaining check'] });
    assert.equal(advice(f).policyAction, 'KEEP_SOL');
    assert.equal(JSON.stringify(f.project.modelRouting), history);
  });

  for (const damage of ['missing', 'foreign', 'stale-unresolved', 'empty', 'support-only', 'wrong-source']) {
    test(`F1 ${kind} mixed hold fails closed with ${damage} causal provenance`, () => {
      const { f, causal, supporting } = mixedBenefit();
      const initial = advice(f);
      initial.hold.triggerRefs = [causal, supporting];
      remember(f, initial);
      Object.assign(f.request, { benefit: null, currentModel: 'gpt-6-astra', stableBoundary: true });
      resolveHeldWork(f);
      if (damage === 'missing') causal.id = 'missing';
      if (damage === 'foreign') causal.projectId = 'other';
      if (damage === 'empty') initial.hold.triggerRefs = [];
      if (damage === 'support-only') initial.hold.triggerRefs = [supporting];
      if (damage === 'stale-unresolved') {
        const record = kind === 'dependency_risk' ? f.project.plans[0] : f.project.efficiency.failedStrategies[0];
        record.revision = 2;
        f.project.evaluations.pop();
        f.project.coordination.criteria.pop();
      }
      if (damage === 'wrong-source') {
        f.request.sourceIdentity = 'source:v2';
        f.project.modelRouting.decisions[0].sourceIdentity = 'source:v2';
        initial.hold.sourceIdentity = 'source:v2';
      }
      assert.equal(router.buildModelRoutingSnapshot(f.project, f.request).holdResolutionSupported, false);
      const result = advice(f);
      assert.notEqual(result.action, 'COMPLETE');
      assert.notEqual(result.policyAction, 'KEEP_SOL');
      assert.ok(result.nextObservation);
    });
  }
}

for (const intervening of ['unresolved', 'preference', 'deferral']) {
  test(`F2 A B A recovers ${intervening} same-source hold history`, () => {
    const f = addDependencyRisk(routingFixture());
    const initial = remember(f);
    Object.assign(f.request, { benefit: null, currentModel: 'gpt-6-astra', stableBoundary: true });
    if (intervening === 'preference') {
      f.request.userPreference = 'sol';
      const preferred = remember(f);
      assert.equal(preferred.policyAction, 'KEEP_SOL');
      assert.ok(preferred.reasonCodes.includes('hold_requires_revalidation'));
      f.request.userPreference = 'auto';
    }
    if (intervening === 'deferral') {
      f.project.plans = [];
      assert.equal(remember(f).policyAction, 'DEFER_ESCALATION');
      supportAllCriteria(f.project);
    }
    f.request.workUnitId = 'work-B';
    remember(f);
    f.request.workUnitId = 'work-1';
    const result = advice(f);
    assert.equal(result.policyAction, intervening === 'deferral' ? 'DEFER_ESCALATION' : 'KEEP_ASTRA');
    assert.notEqual(result.action, 'COMPLETE');
    assert.deepEqual(router.buildModelRoutingSnapshot(f.project, f.request).hold.triggerRefs, initial.hold.triggerRefs);
  });
}

test('F2 same-scope resolution stops lookup before older holds across unrelated decisions', () => {
  const f = addDependencyRisk(routingFixture());
  remember(f);
  Object.assign(f.request, { benefit: null, currentModel: 'gpt-6-astra', stableBoundary: true });
  resolveHeldWork(f);
  assert.equal(remember(f).action, 'COMPLETE');
  f.request.workUnitId = 'work-B';
  remember(f);
  f.request.workUnitId = 'work-1';
  f.project.plans = [];
  f.project.evaluations = [];
  assert.equal(advice(f).action, 'COMPLETE');
  assert.equal(router.buildModelRoutingSnapshot(f.project, f.request).hold, null);
});

test('F2 other-source receipt cannot release the original source hold', () => {
  const f = addDependencyRisk(routingFixture());
  remember(f);
  Object.assign(f.request, { benefit: null, currentModel: 'gpt-6-astra', stableBoundary: true, sourceIdentity: 'source:v2' });
  remember(f);
  f.request.sourceIdentity = 'source:v1';
  assert.equal(advice(f).policyAction, 'KEEP_ASTRA');
});

test('F2 revalidation receipt with missing causal history remains fail closed', () => {
  const f = hold(addDependencyRisk(routingFixture()));
  f.project.plans = [];
  Object.assign(f.request, { benefit: null, currentModel: 'gpt-6-astra', stableBoundary: true });
  assert.equal(remember(f).policyAction, 'DEFER_ESCALATION');
  f.project.modelRouting.decisions.shift();
  supportAllCriteria(f.project);
  assert.equal(advice(f).policyAction, 'DEFER_ESCALATION');
  assert.equal(router.buildModelRoutingSnapshot(f.project, f.request).completionSupported, false);
});

test('F3 eligible custom stay uses generic choice', () => {
  const f = routingFixture({ request: { currentModel: 'operator-future', userPreference: 'stay' } });
  f.runtime = createAdvisoryHostAdapter(readModelEligibility({ ASTRA_REQUIRED_MODEL: 'operator-future' })).describe();
  const result = advice(f);
  assert.equal(result.action, 'REQUEST_USER_CHOICE');
  assert.equal(result.policyAction, 'REQUEST_USER_CHOICE');
  assert.equal(result.recommendedModel, 'operator-future');
  assert.ok(result.nextObservation);
  assert.equal(result.observedModel, null);
  assert.equal(result.executionStatus, 'not_attempted');
});

test('F3 supported completion takes precedence over eligible custom stay', () => {
  const f = routingFixture({ request: { currentModel: 'operator-future', userPreference: 'stay' } });
  f.runtime = createAdvisoryHostAdapter(readModelEligibility({ ASTRA_REQUIRED_MODEL: 'operator-future' })).describe();
  supportAllCriteria(f.project);
  assert.equal(advice(f).action, 'COMPLETE');
});

for (const [name, setup, expectedPolicy, expectedAction] of [
  ['routine supported Sol work', () => routingFixture(), 'KEEP_SOL', 'KEEP_SOL'],
  ['difficult wording without evidenced benefit', () => routingFixture({ project: { goal: 'extremely complex architecture rewrite' } }), 'KEEP_SOL', 'KEEP_SOL'],
  ['initial unresolved high-impact dependency', () => addDependencyRisk(routingFixture()), 'ESCALATE_ASTRA', 'REQUEST_USER_CHOICE'],
  ['same failed strategy without change', () => addFailure(routingFixture()), 'REQUEST_USER_CHOICE', 'REQUEST_USER_CHOICE'],
  ['distinct evidenced hypothesis', () => {
    const f = addFailure(routingFixture());
    f.request.nextHypothesis = { strategyKey: 'instrument-lookahead', changedEvidenceRefs: [],
      changedConditions: ['New parser instrumentation exposes the lookahead cursor'],
      discriminatingCheck: 'Run the regression check with cursor assertions' };
    return f;
  }, 'SOL_RETRY_WITH_NEW_EVIDENCE', 'SOL_RETRY_WITH_NEW_EVIDENCE'],
  ['unresolved Astra hold despite boundary flag', () => {
    const f = hold(addDependencyRisk(routingFixture({ request: { currentModel: 'gpt-6-astra', stableBoundary: true } })));
    f.request.benefit = null;
    return f;
  }, 'KEEP_ASTRA', 'KEEP_ASTRA'],
  ['resolved stable boundary requires manual Sol transition', () => {
    const f = hold(addDependencyRisk(routingFixture({ request: { currentModel: 'gpt-6-astra', stableBoundary: true } })));
    supportAllCriteria(f.project);
    f.project.evaluations.push({ id: 'verified-plan', revision: 1, planId: 'plan-1', outcome: 'verified',
      missingCriteria: [], evidenceIds: ['check-1'] });
    f.project.goalGraph.push({ id: 'goal-2', revision: 1, status: 'active', dependencies: [], successCriteria: ['remaining check'] });
    f.request.benefit = null;
    return f;
  }, 'KEEP_SOL', 'REQUEST_USER_CHOICE'],
]) {
  test(name, () => {
    const result = advice(setup());
    assert.equal(result.policyAction, expectedPolicy);
    assert.equal(result.action, expectedAction);
  });
}

test('mechanically verified difficult edit completes with reported structural provenance', () => {
  const f = routingFixture({ project: { goal: 'complex compiler rewrite' } });
  supportAllCriteria(f.project);
  assert.equal(getCompletionState(f.project).recommended, true);
  const result = advice(f);
  assert.equal(result.action, 'COMPLETE');
  assert.equal(result.recommendedModel, null);
  assert.equal(result.assessmentSource, 'reported');
});

test('Astra forbidden and operator Sol-only default never request Astra', () => {
  for (const restriction of ['caller', 'operator']) {
    const f = addDependencyRisk(routingFixture());
    if (restriction === 'caller') f.request.forbiddenModels = [' GPT-6-ASTRA '];
    else f.runtime = createAdvisoryHostAdapter(readModelEligibility({})).describe();
    const result = advice(f);
    assert.notEqual(result.recommendedModel, 'gpt-6-astra');
    assert.equal(result.action, 'REQUEST_USER_CHOICE');
    assert.ok(result.reasons.length);
  }
});

test('explicit preferences precede optimization but preserve eligibility and verification', () => {
  for (const [preference, current, expectedModel, action] of [
    ['astra', 'gpt-6.1-sol', 'gpt-6-astra', 'REQUEST_USER_CHOICE'],
    ['sol', 'gpt-6-astra', 'gpt-6.1-sol', 'REQUEST_USER_CHOICE'],
    ['stay', 'gpt-6-astra', 'gpt-6-astra', 'KEEP_ASTRA'],
    ['stay', null, null, 'REQUEST_USER_CHOICE'],
  ]) {
    const result = advice(addDependencyRisk(routingFixture({ request: { userPreference: preference, currentModel: current } })));
    assert.equal(result.recommendedModel, expectedModel);
    assert.equal(result.action, action);
    assert.equal(result.verificationPreserved, true);
  }
  const f = routingFixture({ request: { userPreference: 'astra', forbiddenModels: ['gpt-6-astra'] } });
  supportAllCriteria(f.project);
  assert.equal(advice(f).action, 'REQUEST_USER_CHOICE');
  assert.equal(advice(f).recommendedModel, null);
});

test('failure counts alone never change a decision', () => {
  for (const setup of [routingFixture, addFailureFixture]) {
    const baseline = advice(setup());
    for (const failures of [0, 1, 2, 20, 100000]) {
      const f = setup();
      f.project.failureCount = failures;
      f.project.efficiency.failureCount = failures;
      assert.deepEqual(advice(f), baseline);
    }
  }
});
function addFailureFixture() { return addFailure(routingFixture()); }

test('same strategy, reused conditions, unrelated refs and renamed hypothesis cannot authorize a retry', () => {
  for (const patch of [
    { strategyKey: ' same-strategy ', changedConditions: ['New cursor instrumentation'] },
    { strategyKey: 'renamed-strategy', changedConditions: ['old parser configuration'] },
    { strategyKey: 'renamed-strategy', changedConditions: [], changedEvidenceRefs: [routingRef('goal', 'goal-1')] },
    { strategyKey: 'renamed-strategy', changedConditions: [], changedEvidenceRefs: [routingRef('evidence', 'missing')] },
  ]) {
    const f = addFailureFixture();
    f.request.nextHypothesis = { strategyKey: 'new-strategy', changedEvidenceRefs: [], changedConditions: [],
      discriminatingCheck: 'Run regression check', ...patch };
    assert.equal(advice(f).action, 'REQUEST_USER_CHOICE');
  }
});

test('new fresh source-bound evidence supports a distinct Sol hypothesis', () => {
  const f = addFailureFixture();
  f.project.efficiency.failedStrategies[0].newEvidenceIds = [];
  f.request.nextHypothesis = { strategyKey: 'instrument-lookahead',
    changedEvidenceRefs: [routingRef('evidence', f.project.efficiency.evidenceCache[0].key)],
    changedConditions: [], discriminatingCheck: 'Check cursor invariants in the regression check' };
  assert.equal(advice(f).action, 'SOL_RETRY_WITH_NEW_EVIDENCE');
});

test('stale, foreign or irrelevant benefit references defer with a concrete next observation', () => {
  for (const patch of [{ revision: 0 }, { epoch: 'foreign' }, { id: 'missing' }, { kind: 'goal', id: 'goal-1' }]) {
    const f = addDependencyRisk(routingFixture());
    Object.assign(f.request.benefit.refs[0], patch);
    const result = advice(f);
    assert.equal(result.policyAction, 'DEFER_ESCALATION');
    assert.notEqual(result.recommendedModel, 'gpt-6-astra');
    assert.ok(result.nextObservation?.trim());
    assert.ok(result.reasonCodes.length);
    assert.ok(result.reasonCodes.includes('availability_unknown'));
    assert.equal(result.calibration, 'not_measured');
  }
});

test('recorded blocking failures can establish stalled-strategy benefit without a count threshold', () => {
  const f = addFailureFixture();
  f.request.benefit = { kind: 'stalled_strategy', reason: 'Determine a parser invariant to unblock regression check',
    refs: [routingRef('failedStrategy', 'failure-1')] };
  assert.equal(advice(f).policyAction, 'ESCALATE_ASTRA');
});

test('hold is scoped, revalidated and distinct from reported active model', () => {
  const f = hold(addDependencyRisk(routingFixture()));
  f.request.benefit = null;
  const held = advice(f);
  assert.equal(held.policyAction, 'KEEP_ASTRA');
  assert.equal(held.action, 'REQUEST_USER_CHOICE');
  assert.equal(held.observedModel, null);
  for (const patch of [{ workUnitId: 'other' }, { sourceIdentity: 'source:v2' }]) {
    const changed = structuredClone(f);
    Object.assign(changed.request, patch);
    assert.notEqual(advice(changed).policyAction, 'KEEP_ASTRA');
  }
  f.request.forbiddenModels = ['gpt-6-astra'];
  assert.notEqual(advice(f).recommendedModel, 'gpt-6-astra');
});

test('missing or stale hold trigger cannot establish resolution at a stable boundary', () => {
  for (const patch of [{ id: 'missing' }, { revision: 0 }]) {
    const f = hold(addDependencyRisk(routingFixture({ request: { currentModel: 'gpt-6-astra', stableBoundary: true } })));
    Object.assign(f.project.modelRouting.decisions[0].advice.hold.triggerRefs[0], patch);
    f.request.benefit = null;
    const result = advice(f);
    assert.notEqual(result.policyAction, 'KEEP_SOL');
    assert.ok(result.nextObservation);
  }
});

test('risk relabeling and verification from another source cannot release an Astra hold', () => {
  for (const mutation of ['risk-label', 'source-binding']) {
    const f = hold(addDependencyRisk(routingFixture({ request: { currentModel: 'gpt-6-astra', stableBoundary: true } })));
    f.request.benefit = null;
    if (mutation === 'risk-label') Object.assign(f.project.plans[0], { risk: 'low', verificationRisk: 'low',
      expectedDecisionImpact: 'low', reversible: true });
    else {
      supportAllCriteria(f.project);
      f.project.evaluations.push({ id: 'verified-plan', revision: 1, planId: 'plan-1', outcome: 'verified',
        missingCriteria: [], evidenceIds: ['check-1'] });
      f.request.sourceIdentity = 'source:v2';
      const previous = f.project.modelRouting.decisions[0];
      previous.sourceIdentity = 'source:v2';
      previous.advice.hold.sourceIdentity = 'source:v2';
    }
    assert.equal(advice(f).policyAction, 'KEEP_ASTRA');
  }
});

test('supported resolution without a stable boundary still retains Astra', () => {
  const f = hold(addDependencyRisk(routingFixture({ request: { currentModel: 'gpt-6-astra' } })));
  supportAllCriteria(f.project);
  f.project.evaluations.push({ id: 'verified-plan', revision: 1, planId: 'plan-1', outcome: 'verified',
    missingCriteria: [], evidenceIds: ['check-1'] });
  f.project.goalGraph.push({ id: 'goal-2', revision: 1, status: 'active', dependencies: [], successCriteria: ['remaining check'] });
  f.request.benefit = null;
  assert.equal(advice(f).policyAction, 'KEEP_ASTRA');
});

test('persisting a deferred missing trigger cannot silently drop the unresolved hold on the next route', () => {
  const f = hold(addDependencyRisk(routingFixture({ request: { currentModel: 'gpt-6-astra', stableBoundary: true } })));
  f.request.benefit = null;
  f.project.plans = [];
  const first = advice(f);
  assert.equal(first.policyAction, 'DEFER_ESCALATION');
  f.project.modelRouting.decisions.push({ id: 'deferred', revision: 1, workUnitId: 'work-1',
    sourceIdentity: 'source:v1', advice: first });
  const second = advice(f);
  assert.equal(second.policyAction, 'DEFER_ESCALATION');
  assert.ok(second.nextObservation);
});

test('supported completion cannot bypass a missing historical hold trigger or its persisted deferral', () => {
  const f = hold(addDependencyRisk(routingFixture({ request: { currentModel: 'gpt-6-astra', stableBoundary: true } })));
  const triggerPlan = f.project.plans[0];
  f.request.benefit = null;
  supportAllCriteria(f.project);
  f.project.plans = [];
  assert.equal(getCompletionState(f.project).recommended, true);
  const snapshot = router.buildModelRoutingSnapshot(f.project, f.request);
  assert.equal(snapshot.holdReferences[0].status, 'not_found');
  assert.equal(snapshot.completionSupported, false);
  const first = advice(f);
  assert.equal(first.policyAction, 'DEFER_ESCALATION');
  assert.ok(first.unmetCriteria.some(item => /hold/i.test(item)));
  assert.ok(first.nextObservation);
  f.project.modelRouting.decisions.push({ id: 'deferred', revision: 1, workUnitId: 'work-1',
    sourceIdentity: 'source:v1', advice: first });
  assert.equal(advice(f).policyAction, 'DEFER_ESCALATION');
  f.request.userPreference = 'sol';
  const preferred = advice(f);
  assert.equal(preferred.policyAction, 'KEEP_SOL');
  assert.equal(preferred.action, 'REQUEST_USER_CHOICE');
  assert.ok(preferred.unmetCriteria.some(item => /hold/i.test(item)));
  f.project.modelRouting.decisions.push({ id: 'preferred', revision: 1, workUnitId: 'work-1',
    sourceIdentity: 'source:v1', advice: preferred });
  const nextSnapshot = router.buildModelRoutingSnapshot(f.project, f.request);
  assert.equal(nextSnapshot.completionSupported, false);
  assert.equal(nextSnapshot.holdReferences[0].status, 'not_found');
  const repeatedPreference = advice(f);
  assert.equal(repeatedPreference.policyAction, 'KEEP_SOL');
  assert.equal(repeatedPreference.action, 'REQUEST_USER_CHOICE');
  f.project.modelRouting.decisions.push({ id: 'preferred-again', revision: 1, workUnitId: 'work-1',
    sourceIdentity: 'source:v1', advice: repeatedPreference });
  f.request.currentModel = 'gpt-6.1-sol';
  f.request.userPreference = 'auto';
  const afterManualTransition = advice(f);
  assert.equal(afterManualTransition.policyAction, 'DEFER_ESCALATION');
  assert.ok(afterManualTransition.unmetCriteria.some(item => /hold/i.test(item)));
  f.project.plans.push(triggerPlan);
  f.project.evaluations.push({ id: 'verified-plan', revision: 1, planId: 'plan-1', outcome: 'verified',
    missingCriteria: [], evidenceIds: ['check-1'] });
  const resolved = advice(f);
  assert.equal(resolved.action, 'COMPLETE');
  assert.ok(!resolved.reasonCodes.includes('hold_requires_revalidation'));
});

for (const [name, restrict] of [
  ['forbidden explicit preference', f => {
    f.request.userPreference = 'astra'; f.request.forbiddenModels = ['gpt-6-astra'];
  }],
  ['stay without reported identity', f => {
    f.request.userPreference = 'stay'; f.request.currentModel = null;
  }],
  ['operator denies both destinations', f => {
    f.runtime = createAdvisoryHostAdapter(readModelEligibility({ ASTRA_REQUIRED_MODEL: 'operator-other' })).describe();
  }],
  ['unknown reported model', f => { f.request.currentModel = 'unknown'; }],
  ['forbidden reported model', f => { f.request.forbiddenModels = ['gpt-6-astra']; }],
]) {
  test(`persisted ${name} choice retains unresolved historical hold verification`, () => {
    const f = hold(addDependencyRisk(routingFixture({ request: { currentModel: 'gpt-6-astra', stableBoundary: true } })));
    const runtime = f.runtime;
    f.request.benefit = null;
    supportAllCriteria(f.project);
    f.project.plans = [];
    restrict(f);
    const choice = advice(f);
    assert.equal(choice.action, 'REQUEST_USER_CHOICE');
    assert.equal(choice.recommendedModel, null);
    assert.ok(choice.unmetCriteria.some(item => /hold/i.test(item)));
    f.project.modelRouting.decisions.push({ id: 'choice', revision: 1, workUnitId: 'work-1',
      sourceIdentity: 'source:v1', advice: choice });
    f.runtime = runtime;
    Object.assign(f.request, { userPreference: 'auto', currentModel: 'gpt-6.1-sol', forbiddenModels: [] });
    const resumed = advice(f);
    assert.equal(resumed.policyAction, 'DEFER_ESCALATION');
    assert.ok(resumed.unmetCriteria.some(item => /hold/i.test(item)));
  });
}

test('supported plan resolution still permits Sol downgrade after lowering the plan risk', () => {
  const f = hold(addDependencyRisk(routingFixture({ request: { currentModel: 'gpt-6-astra', stableBoundary: true } })));
  f.request.benefit = null;
  supportAllCriteria(f.project);
  f.project.evaluations.push({ id: 'verified-plan', revision: 1, planId: 'plan-1', outcome: 'verified',
    missingCriteria: [], evidenceIds: ['check-1'] });
  f.project.goalGraph.push({ id: 'goal-2', revision: 1, status: 'active', dependencies: [], successCriteria: ['remaining check'] });
  assert.equal(advice(f).policyAction, 'KEEP_SOL');
  Object.assign(f.project.plans[0], { risk: 'low', verificationRisk: 'low', expectedDecisionImpact: 'low', reversible: true });
  assert.deepEqual(router.buildModelRoutingSnapshot(f.project, f.request).risk, []);
  const reduced = advice(f);
  assert.equal(reduced.policyAction, 'KEEP_SOL');
  assert.equal(reduced.action, 'REQUEST_USER_CHOICE');
  f.project.evaluations = [];
  assert.equal(advice(f).policyAction, 'KEEP_ASTRA');
});

test('a changed current trigger version is revalidated against supported resolution', () => {
  const f = hold(addDependencyRisk(routingFixture({ request: { currentModel: 'gpt-6-astra', stableBoundary: true } })));
  f.request.benefit = null;
  f.project.plans[0].revision = 2;
  supportAllCriteria(f.project);
  f.project.evaluations.push({ id: 'verified-plan', revision: 2, planId: 'plan-1', outcome: 'verified',
    missingCriteria: [], evidenceIds: ['check-1'] });
  f.project.goalGraph.push({ id: 'goal-2', revision: 1, status: 'active', dependencies: [], successCriteria: ['remaining check'] });
  assert.equal(advice(f).policyAction, 'KEEP_SOL');
});

test('deleting stalled criteria cannot count an unrelated verified goal as resolution', () => {
  const f = addFailureFixture();
  f.request.currentModel = 'gpt-6-astra';
  f.request.stableBoundary = true;
  f.project.modelRouting = { version: 1, decisions: [{ id: 'previous', revision: 1,
    workUnitId: 'work-1', sourceIdentity: 'source:v1', advice: { recommendedModel: 'gpt-6-astra',
      hold: { model: 'gpt-6-astra', workUnitId: 'work-1', sourceIdentity: 'source:v1',
        triggerKind: 'stalled_strategy', triggerRefs: [routingRef('failedStrategy', 'failure-1')] } } }], operations: {} };
  f.project.evaluations = [];
  f.project.goalGraph.push({ ...structuredClone(f.project.goalGraph[0]), id: 'goal-2' });
  supportAllCriteria(f.project);
  f.project.coordination.criteria = f.project.coordination.criteria.map(item => ({ ...item, goalId: 'goal-2' }));
  f.project.goalGraph[0].successCriteria = [];
  assert.equal(advice(f).policyAction, 'KEEP_ASTRA');
});

for (const [name, mutate] of [
  ['stale support', f => { f.project.efficiency.evidenceCache[0].freshness = 'stale'; }],
  ['changed source', f => { f.request.sourceIdentity = 'source:v2'; }],
  ['unknown source binding', f => { f.project.efficiency.evidenceCache[0].dependencies = []; }],
  ['empty required criteria', f => { f.project.goalGraph[0].successCriteria = []; }],
  ['registered counter-evidence', f => { f.project.claims.push({ id: 'claim-1', status: 'known', counterEvidenceIds: ['counter-1'] }); }],
  ['unresolved risk', f => { addDependencyRisk(f); }],
]) {
  test(`${name} and superficial success cannot complete`, () => {
    const f = routingFixture();
    supportAllCriteria(f.project);
    mutate(f);
    const result = advice(f, { successCriteriaSatisfied: true, evidenceSufficient: true, stableBoundary: true });
    assert.notEqual(result.action, 'COMPLETE');
    assert.equal(result.verificationPreserved, true);
    assert.ok(result.unmetCriteria.length);
  });
}

test('negative workflow reports block structurally complete projects and optimistic reports never establish completion', () => {
  for (const signals of [{ importantUncertainty: true }, { contradictionRemaining: true },
    { meaningfulRiskRemaining: true }, { unmetSuccessCriteria: ['package regression pending'] }]) {
    const f = routingFixture();
    supportAllCriteria(f.project);
    assert.notEqual(advice(f, signals).action, 'COMPLETE');
  }
  assert.notEqual(advice(routingFixture(), { successCriteriaSatisfied: true, evidenceSufficient: true,
    importantUncertainty: false, contradictionRemaining: false, meaningfulRiskRemaining: false, unmetSuccessCriteria: [] }).action, 'COMPLETE');
});

test('budget exhaustion cannot lower verification across all policies and routes', () => {
  for (const policy of ['eco', 'balanced', 'performance', 'maximum']) {
    for (const route of ['off', 'light', 'standard', 'deep']) {
      const { softCycleBudget } = policyBudget(policy, route);
      const f = routingFixture();
      f.project.efficiency.policy = policy;
      f.project.efficiency.completedCycles = softCycleBudget + 100;
      const result = advice(f, { completedCycles: softCycleBudget + 100, softCycleBudget,
        successCriteriaSatisfied: true, evidenceSufficient: true });
      assert.notEqual(result.action, 'COMPLETE');
      assert.equal(result.verificationPreserved, true);
      assert.equal(result.remainingVerifiedCost, null);
    }
  }
});

test('unknown source/identity is not success and projectless advice cannot establish reference benefits', () => {
  const f = addDependencyRisk(routingFixture({ request: { currentModel: null } }));
  f.project = null;
  delete f.request.operationId;
  delete f.request.expectedState;
  const result = advice(f, { successCriteriaSatisfied: true, evidenceSufficient: true });
  assert.notEqual(result.action, 'COMPLETE');
  assert.notEqual(result.recommendedModel, 'gpt-6-astra');
  assert.equal(result.assessmentSource, 'unknown');
  assert.equal(result.observedModel, null);
  assert.equal(result.remainingVerifiedCost, null);
  const complete = routingFixture({ request: { currentModel: 'unknown' } });
  supportAllCriteria(complete.project);
  assert.notEqual(advice(complete).action, 'COMPLETE');
});

test('canonical validator accepts v1 and optional current-reference revisions without widening requests', () => {
  const f = addDependencyRisk(routingFixture());
  delete f.request.benefit.refs[0].revision;
  assert.deepEqual(validate(f.request, { projectId: 'routing-test' }), f.request);
  delete f.request.operationId;
  delete f.request.expectedState;
  assert.deepEqual(validate(f.request, {}), f.request);
});

test('canonical validator rejects every missing required field, unknown field and project envelope mismatch', () => {
  const { request } = routingFixture();
  for (const key of Object.keys(request)) {
    const candidate = structuredClone(request);
    delete candidate[key];
    assert.throws(() => validate(candidate, { projectId: 'routing-test' }), TypeError, key);
  }
  for (const patch of [{ version: 2 }, { unknown: true }, { stableBoundary: 'true' },
    { currentModel: 1 }, { workUnitId: ' ' }, { sourceIdentity: '' }, { userPreference: 'cheap' },
    { forbiddenModels: [null] }, { receiverCanResolveReferences: null },
    { expectedState: { ...request.expectedState, revision: Number.MAX_SAFE_INTEGER + 1 } },
    { expectedState: { ...request.expectedState, revision: -1 } },
    { expectedState: { ...request.expectedState, projectId: 'foreign' } },
    { expectedState: { ...request.expectedState, extra: 1 } },
    { nextHypothesis: { strategyKey: 'new', changedEvidenceRefs: [], changedConditions: [], discriminatingCheck: '' } },
    { benefit: { kind: 'complex', reason: 'hard', refs: [] } },
  ]) assert.throws(() => validate({ ...request, ...patch }, { projectId: 'routing-test' }), TypeError);
  assert.throws(() => validate(request, {}), TypeError);
});

test('canonical validator rejects malformed refs and non-JSON input without executing accessors', () => {
  const f = addDependencyRisk(routingFixture());
  for (const patch of [{ kind: 'unknown' }, { id: '' }, { epoch: '' }, { projectId: '' },
    { revision: -1 }, { revision: Infinity }, { extra: true }]) {
    const request = structuredClone(f.request);
    Object.assign(request.benefit.refs[0], patch);
    assert.throws(() => validate(request, { projectId: 'routing-test' }), TypeError);
  }
  for (const extra of [undefined, () => {}, Symbol('x'), 1n, NaN, new Date(), new Map()]) {
    assert.throws(() => validate({ ...f.request, extra }, { projectId: 'routing-test' }), TypeError);
  }
  const cyclic = structuredClone(f.request); cyclic.extra = cyclic;
  assert.throws(() => validate(cyclic, { projectId: 'routing-test' }), TypeError);
  let invoked = false;
  const getter = structuredClone(f.request);
  Object.defineProperty(getter, 'version', { enumerable: true, get() { invoked = true; return 1; } });
  assert.throws(() => validate(getter, { projectId: 'routing-test' }), TypeError);
  assert.equal(invoked, false);
  const nestedGetter = structuredClone(f.request);
  Object.defineProperty(nestedGetter.benefit.refs[0], 'id', {
    enumerable: true, get() { invoked = true; throw new Error('must not execute'); },
  });
  assert.throws(() => validate(nestedGetter, { projectId: 'routing-test' }), TypeError);
  assert.equal(invoked, false);
});

test('canonical validator rejects nested extensions, unsafe hypothesis refs and lossy JSON containers', () => {
  const f = addDependencyRisk(routingFixture());
  const badRequests = [];
  const extendedBenefit = structuredClone(f.request); extendedBenefit.benefit.extra = true;
  badRequests.push(extendedBenefit);
  for (const patch of [{ extra: true }, { strategyKey: '' }, { changedConditions: [7] },
    { changedEvidenceRefs: [routingRef('evidence', 'x'), null] }, { discriminatingCheck: null }]) {
    badRequests.push({ ...f.request, nextHypothesis: { strategyKey: 'different', changedEvidenceRefs: [],
      changedConditions: ['new instrumentation'], discriminatingCheck: 'Run regression check', ...patch } });
  }
  const hidden = structuredClone(f.request);
  Object.defineProperty(hidden, 'hidden', { value: true }); badRequests.push(hidden);
  const symbol = structuredClone(f.request); symbol[Symbol('x')] = true; badRequests.push(symbol);
  badRequests.push({ ...f.request, forbiddenModels: new Array(1) });
  const extraArrayProperty = []; extraArrayProperty.extra = true;
  badRequests.push({ ...f.request, forbiddenModels: extraArrayProperty });
  for (const request of badRequests) assert.throws(() => validate(request, { projectId: 'routing-test' }), TypeError);
});

test('deep-frozen inputs produce deterministic advice with honest requested/observed facts and no mutation', () => {
  for (const f of [routingFixture(), addDependencyRisk(routingFixture()), addFailureFixture()]) {
    const before = structuredClone(f);
    freeze(f);
    const first = advice(f);
    assert.deepEqual(advice(f), first);
    assert.deepEqual(f, before);
    assert.equal(first.version, 1);
    assert.equal(first.advisory, true);
    assert.equal(first.executionStatus, 'not_attempted');
    assert.equal(first.observedModel, null);
    assert.equal(first.remainingVerifiedCost, null);
    assert.equal(first.calibration, 'not_measured');
    assert.equal(first.verificationPreserved, true);
    assert.ok(first.reasonCodes.length && first.reasons.length);
  }
});
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
