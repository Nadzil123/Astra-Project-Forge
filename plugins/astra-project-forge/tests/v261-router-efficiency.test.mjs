import test from 'node:test';
import assert from 'node:assert/strict';
import { routeTask } from '../server/adaptive-router.mjs';

const deepInput = { complexity: 'complex', uncertainty: 'high', continuityNeeded: true };

test('balanced deep work uses soft budget three by default', () => {
  for (const efficiencyPolicy of [undefined, 'balanced', 'unknown', null]) {
    const route = routeTask({ ...deepInput, efficiencyPolicy });
    assert.equal(route.profile, 'deep');
    assert.equal(route.efficiencyPolicy, 'balanced');
    assert.equal(route.softCycleBudget, 3);
    assert.equal(route.cycleBudget, 3);
  }
});

for (const [efficiencyPolicy, budgets] of [
  ['eco', [0, 1, 1, 2]],
  ['balanced', [0, 1, 3, 3]],
  ['performance', [0, 1, 3, 5]],
  ['maximum', [0, 1, 4, 6]],
]) {
  test(`${efficiencyPolicy} budgets preserve routing and context decisions`, () => {
    const inputs = [
      { complexity: 'simple', uncertainty: 'low' },
      { complexity: 'moderate', uncertainty: 'low', verificationNeeded: false, multiStep: false },
      {},
      deepInput,
    ];
    inputs.forEach((input, index) => {
      const { cycleBudget, ...legacy } = routeTask(input);
      const route = routeTask({ ...input, efficiencyPolicy: ` ${efficiencyPolicy.toUpperCase()} ` });
      assert.equal(route.profile, ['off', 'light', 'standard', 'deep'][index]);
      assert.equal(route.efficiencyPolicy, efficiencyPolicy);
      assert.equal(route.softCycleBudget, budgets[index]);
      assert.equal(route.cycleBudget, budgets[index]);
      for (const field of ['profile', 'score', 'complexity', 'uncertainty', 'stateDetail',
        'contextDetail', 'usageImpact', 'risk', 'expectedIterations', 'projectMode',
        'checkpointRecommended', 'capabilityNeeds', 'reasons', 'guidance']) {
        assert.deepEqual(route[field], legacy[field], field);
      }
    });
  });
}

test('soft budget requires justification at and beyond the boundary, never a hard stop', () => {
  for (const completedCycles of [2, 3, 9]) {
    const route = routeTask({ ...deepInput, completedCycles, softCycleBudget: 100 });
    assert.equal(route.efficiencyDecision, completedCycles < 3 ? 'allow' : 'justify');
    assert.equal(route.requiresJustification, completedCycles >= 3);
    assert.equal(route.completionRecommended, false);
  }
});

for (const [signal, reason] of [
  ['candidateWouldVerifySuccessCriterion', 'unmet_success_criterion'],
  ['candidateWouldResolveUncertainty', 'important_uncertainty'],
  ['candidateWouldReduceRisk', 'high_risk_verification'],
  ['candidateWouldResolveContradiction', 'contradictory_evidence'],
  ['candidateWouldProduceNewEvidence', 'new_evidence'],
  ['candidateWouldChangeDecision', 'decision_impact'],
  ['candidateWouldDetectFailure', 'meaningful_failure_detection'],
  ['candidateWouldUnblockDependency', 'blocked_goal'],
  ['candidateWouldMakeProgress', 'goal_progress'],
]) {
  test(`${signal} permits useful work beyond budget with a justification reason`, () => {
    const route = routeTask({ ...deepInput, completedCycles: 3,
      unmetSuccessCriteria: ['fresh verification'], [signal]: true });
    assert.equal(route.efficiencyDecision, 'allow');
    assert.equal(route.requiresJustification, true);
    assert.deepEqual(route.usefulReasons, [reason]);
    assert.deepEqual(route.wasteReasons, []);
  });
}

test('replanning needs both fresh evidence and a candidate that replans', () => {
  for (const candidateWouldReplan of [false, true]) {
    const route = routeTask({ ...deepInput, completedCycles: 3,
      newEvidenceRequiresReplan: true, candidateWouldReplan });
    assert.equal(route.efficiencyDecision, candidateWouldReplan ? 'allow' : 'justify');
    assert.deepEqual(route.usefulReasons, candidateWouldReplan ? ['new_evidence_requires_replan'] : []);
  }
});

for (const [signal, reason] of [
  ['duplicateValidEvidence', 'duplicate_valid_evidence'],
  ['repeatsFailedStrategyWithoutNewEvidence', 'repeated_failed_strategy'],
  ['irrelevantContextReload', 'irrelevant_context'],
  ['noExpectedDecisionImpact', 'no_expected_decision_impact'],
  ['alreadySufficientlyVerified', 'already_sufficiently_verified'],
  ['duplicateConcurrentAction', 'duplicate_concurrent_action'],
]) {
  test(`${signal} skips waste even with useful hints`, () => {
    const route = routeTask({ ...deepInput, [signal]: true, candidateWouldProduceNewEvidence: true });
    assert.equal(route.efficiencyDecision, 'skip');
    assert.equal(route.requiresJustification, false);
    assert.deepEqual(route.usefulReasons, ['new_evidence']);
    assert.deepEqual(route.wasteReasons, [reason]);
  });
}

test('independent candidate value permits otherwise duplicate work', () => {
  const route = routeTask({ ...deepInput, completedCycles: 4, duplicateValidEvidence: true,
    duplicateConcurrentAction: true, candidateHasIndependentValue: true,
    candidateWouldDetectFailure: true });
  assert.equal(route.efficiencyDecision, 'allow');
  assert.equal(route.requiresJustification, true);
  assert.deepEqual(route.usefulReasons, ['meaningful_failure_detection']);
  assert.deepEqual(route.wasteReasons, []);
});

const completion = { successCriteriaSatisfied: true, evidenceSufficient: true,
  contradictionRemaining: false, meaningfulRiskRemaining: false };

test('verified completion stops deep work before budget even with useful candidates', () => {
  const route = routeTask({ ...deepInput, ...completion, candidateWouldMakeProgress: true });
  assert.equal(route.profile, 'deep');
  assert.equal(route.completionRecommended, true);
  assert.equal(route.efficiencyDecision, 'stop');
  assert.equal(route.requiresJustification, false);
  assert.deepEqual(route.usefulReasons, []);
  assert.deepEqual(route.wasteReasons, ['success_verified']);
});

test('completion requires every explicit signal', () => {
  for (const field of Object.keys(completion)) {
    for (const value of [undefined, !completion[field]]) {
      const route = routeTask({ ...deepInput, ...completion, [field]: value });
      assert.equal(route.completionRecommended, false, field);
      assert.equal(route.efficiencyDecision, 'allow', field);
    }
  }
});

test('routing is deterministic without mutating input or fabricating usage', () => {
  const input = Object.freeze({ ...deepInput, completedCycles: 3,
    capabilityNeeds: Object.freeze(['testing', 'testing']), candidateWouldProduceNewEvidence: true });
  const route = routeTask(input);
  assert.deepEqual(route.usefulReasons, ['new_evidence']);
  assert.deepEqual(routeTask(input), route);
  assert.equal(input.completedCycles, 3);
  assert.deepEqual(input.capabilityNeeds, ['testing', 'testing']);
  assert.deepEqual(Object.keys(route).sort(), [
    'profile', 'score', 'complexity', 'uncertainty', 'cycleBudget', 'stateDetail', 'contextDetail',
    'usageImpact', 'risk', 'expectedIterations', 'projectMode', 'checkpointRecommended',
    'capabilityNeeds', 'reasons', 'guidance', 'efficiencyPolicy', 'softCycleBudget',
    'requiresJustification', 'efficiencyDecision', 'completionRecommended', 'usefulReasons', 'wasteReasons',
  ].sort());
});
