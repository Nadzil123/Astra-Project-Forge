import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEfficiencyPolicy,
  policyBudget,
  assessUtility,
  shouldComplete,
  nextReasoningLevel,
} from '../server/efficiency-governor.mjs';

const verified = Object.freeze({
  successCriteriaSatisfied: true,
  evidenceSufficient: true,
  contradictionRemaining: false,
  meaningfulRiskRemaining: false,
});

test('policy normalization accepts supported policies with case and whitespace', () => {
  for (const [input, expected] of [
    [' ECO ', 'eco'], ['balanced', 'balanced'],
    ['Performance', 'performance'], ['MAXIMUM', 'maximum'],
  ]) {
    assert.equal(normalizeEfficiencyPolicy(input), expected);
  }
});

test('missing and unknown policies default to balanced without coercing objects', () => {
  assert.equal(normalizeEfficiencyPolicy(), 'balanced');
  for (const input of [null, '', 'turbo', '__proto__', 'constructor', 3, true, [], {}, Symbol('eco'), Object.create(null)]) {
    assert.equal(normalizeEfficiencyPolicy(input), 'balanced');
  }
});

for (const [policy, budgets, contextPreference] of [
  ['eco', [0, 1, 1, 2], 'summary'],
  ['balanced', [0, 1, 3, 3], 'working'],
  ['performance', [0, 1, 3, 5], 'working'],
  ['maximum', [0, 1, 4, 6], 'working'],
]) {
  for (const [index, route] of ['off', 'light', 'standard', 'deep'].entries()) {
    test(`${policy}/${route} supplies a soft budget and context preference`, () => {
      assert.deepEqual(policyBudget(policy, route), {
        softCycleBudget: budgets[index], contextPreference,
      });
    });
  }
}

test('unknown routes fall back to standard without reading inherited properties', () => {
  assert.deepEqual(policyBudget(), { softCycleBudget: 3, contextPreference: 'working' });
  for (const route of [null, 'unknown', '__proto__', 'constructor', 'toString', {}, [], Symbol('deep')]) {
    assert.deepEqual(policyBudget('eco', route), { softCycleBudget: 1, contextPreference: 'summary' });
  }
  assert.deepEqual(policyBudget('invalid', 'deep'), { softCycleBudget: 3, contextPreference: 'working' });
});

test('completion requires all four explicit verified outcomes', () => {
  assert.equal(shouldComplete(verified), true);
  for (const key of Object.keys(verified)) {
    const missing = { ...verified };
    delete missing[key];
    assert.equal(shouldComplete(missing), false, `${key} must be explicit`);
    for (const value of [!verified[key], undefined, null, 'true', 'false', 0, 1, {}]) {
      assert.equal(shouldComplete({ ...verified, [key]: value }), false, `${key} rejects ${String(value)}`);
    }
  }
});

test('verified success stops immediately regardless of remaining budget or candidate value', () => {
  for (const completedCycles of [0, 3, 20]) {
    assert.deepEqual(assessUtility({
      ...verified, completedCycles, softCycleBudget: 3,
      candidateWouldProduceNewEvidence: true,
    }), {
      decision: 'stop', usefulReasons: [], wasteReasons: ['success_verified'], requiresJustification: false,
    });
  }
});

test('incomplete verification, contradictions, and unresolved risk cannot stop work', () => {
  for (const patch of [
    { successCriteriaSatisfied: false }, { evidenceSufficient: false },
    { contradictionRemaining: true }, { meaningfulRiskRemaining: true },
    { contradictionRemaining: undefined }, { meaningfulRiskRemaining: undefined },
  ]) {
    assert.equal(assessUtility({
      ...verified, ...patch, completedCycles: 50, softCycleBudget: 1,
      candidateWouldProduceNewEvidence: true,
    }).decision, 'allow');
  }
});

const usefulCandidates = [
  ['unmet_success_criterion', { candidateWouldVerifySuccessCriterion: true }],
  ['important_uncertainty', { candidateWouldResolveUncertainty: true }],
  ['high_risk_verification', { candidateWouldReduceRisk: true }],
  ['contradictory_evidence', { candidateWouldResolveContradiction: true }],
  ['new_evidence', { candidateWouldProduceNewEvidence: true }],
  ['decision_impact', { candidateWouldChangeDecision: true }],
  ['meaningful_failure_detection', { candidateWouldDetectFailure: true }],
  ['blocked_goal', { candidateWouldUnblockDependency: true }],
  ['goal_progress', { candidateWouldMakeProgress: true }],
  ['new_evidence_requires_replan', { newEvidenceRequiresReplan: true, candidateWouldReplan: true }],
];

for (const [reason, candidate] of usefulCandidates) {
  test(`candidate utility ${reason} permits work at and beyond every policy budget`, () => {
    for (const policy of ['eco', 'balanced', 'performance', 'maximum']) {
      for (const route of ['off', 'light', 'standard', 'deep']) {
        const { softCycleBudget } = policyBudget(policy, route);
        for (const completedCycles of [softCycleBudget, softCycleBudget + 10]) {
          assert.deepEqual(assessUtility({ ...candidate, completedCycles, softCycleBudget }), {
            decision: 'allow', usefulReasons: [reason], wasteReasons: [], requiresJustification: true,
          });
        }
      }
    }
  });
}

test('useful work below budget needs no override justification', () => {
  assert.deepEqual(assessUtility({
    completedCycles: 2, softCycleBudget: 3, candidateWouldProduceNewEvidence: true,
  }), {
    decision: 'allow', usefulReasons: ['new_evidence'], wasteReasons: [], requiresJustification: false,
  });
});

test('the brief example continues useful verification past its soft budget', () => {
  const result = assessUtility({
    completedCycles: 3, softCycleBudget: 3,
    unmetSuccessCriteria: ['package not verified'], importantUncertainty: true,
    candidateWouldProduceNewEvidence: true,
  });
  assert.equal(result.decision, 'allow');
  assert.equal(result.requiresJustification, true);
  assert.ok(result.usefulReasons.includes('new_evidence'));
});

test('unrelated unfinished work does not justify the next candidate', () => {
  assert.deepEqual(assessUtility({
    completedCycles: 3, softCycleBudget: 3,
    unmetSuccessCriteria: ['unrelated tests'], importantUncertainty: true,
    contradictionRemaining: true, meaningfulRiskRemaining: true,
    blockedGoal: true, newEvidenceRequiresReplan: true,
  }), { decision: 'justify', usefulReasons: [], wasteReasons: [], requiresJustification: true });
});

for (const [flag, reason] of [
  ['duplicateValidEvidence', 'duplicate_valid_evidence'],
  ['repeatsFailedStrategyWithoutNewEvidence', 'repeated_failed_strategy'],
  ['irrelevantContextReload', 'irrelevant_context'],
  ['noExpectedDecisionImpact', 'no_expected_decision_impact'],
  ['alreadySufficientlyVerified', 'already_sufficiently_verified'],
  ['duplicateConcurrentAction', 'duplicate_concurrent_action'],
]) {
  test(`${flag} is skipped even with unrelated unmet criteria and risk`, () => {
    for (const completedCycles of [0, 3, 10]) {
      assert.deepEqual(assessUtility({
        [flag]: true, completedCycles, softCycleBudget: 3,
        unmetSuccessCriteria: ['unrelated release'], importantUncertainty: true,
        contradictionRemaining: true, meaningfulRiskRemaining: true,
      }), { decision: 'skip', usefulReasons: [], wasteReasons: [reason], requiresJustification: false });
    }
  });
}

test('explicit no-impact work is skipped even when it would produce new evidence', () => {
  const result = assessUtility({
    candidateWouldProduceNewEvidence: true, noExpectedDecisionImpact: true,
    completedCycles: 3, softCycleBudget: 3,
  });
  assert.equal(result.decision, 'skip');
  assert.equal(result.requiresJustification, false);
  assert.ok(result.wasteReasons.includes('no_expected_decision_impact'));
});

test('duplicate work needs declared independent value as well as a useful outcome', () => {
  for (const flag of ['duplicateValidEvidence', 'duplicateConcurrentAction']) {
    assert.equal(assessUtility({ [flag]: true, candidateWouldProduceNewEvidence: true }).decision, 'skip');
    assert.equal(assessUtility({ [flag]: true, candidateHasIndependentValue: true }).decision, 'skip');
    const result = assessUtility({
      [flag]: true, candidateHasIndependentValue: true, candidateWouldDetectFailure: true,
      completedCycles: 4, softCycleBudget: 3,
    });
    assert.equal(result.decision, 'allow');
    assert.equal(result.requiresJustification, true);
    assert.deepEqual(result.wasteReasons, []);
  }
});

test('a blocked goal or new evidence alone does not make an unrelated replan useful', () => {
  for (const candidate of [
    { blockedGoal: true }, { newEvidenceRequiresReplan: true }, { candidateWouldReplan: true },
    { newEvidenceRequiresReplan: true, candidateWouldReplan: false },
  ]) {
    assert.equal(assessUtility({ ...candidate, softCycleBudget: 0 }).decision, 'justify');
  }
});

test('unknown utility is allowed below budget and requires justification at the boundary', () => {
  assert.deepEqual(assessUtility(), {
    decision: 'allow', usefulReasons: [], wasteReasons: [], requiresJustification: false,
  });
  for (const completedCycles of [2, 3, 4]) {
    const result = assessUtility({ completedCycles, softCycleBudget: 3 });
    assert.equal(result.decision, completedCycles < 3 ? 'allow' : 'justify');
    assert.equal(result.requiresJustification, completedCycles >= 3);
  }
});

test('utility flags require booleans, including independent duplicate value', () => {
  for (const value of ['true', 1, {}, null]) {
    assert.equal(assessUtility({ softCycleBudget: 0, candidateWouldProduceNewEvidence: value }).decision, 'justify');
    assert.equal(assessUtility({ duplicateValidEvidence: value }).decision, 'allow');
    assert.equal(assessUtility({
      duplicateValidEvidence: true, candidateHasIndependentValue: value, candidateWouldDetectFailure: true,
    }).decision, 'skip');
  }
});

test('cycle inputs accept numeric strings and ignore malformed values conservatively', () => {
  assert.equal(assessUtility({ completedCycles: '3', softCycleBudget: '3' }).requiresJustification, true);
  for (const value of [undefined, null, '', 'unknown', -1, NaN, Infinity, true, {}, [], Symbol('cycles')]) {
    assert.equal(assessUtility({ completedCycles: value, softCycleBudget: 3 }).requiresJustification, false);
    assert.equal(assessUtility({ completedCycles: 3, softCycleBudget: value }).requiresJustification, false);
  }
});

test('null and non-record inputs use conservative utility and completion defaults', () => {
  for (const input of [null, false, 42, 'unknown', [], Symbol('input')]) {
    assert.equal(shouldComplete(input), false);
    assert.deepEqual(assessUtility(input), {
      decision: 'allow', usefulReasons: [], wasteReasons: [], requiresJustification: false,
    });
    assert.deepEqual(nextReasoningLevel(input), { level: 'low', changed: false, reason: 'no_change' });
  }
});

test('unknown reasoning levels default to low without claiming host effort changes', () => {
  assert.deepEqual(nextReasoningLevel(), { level: 'low', changed: false, reason: 'no_change' });
  for (const currentLevel of ['turbo', '__proto__', 'constructor', null, {}, Symbol('level')]) {
    assert.deepEqual(nextReasoningLevel({ currentLevel }), { level: 'low', changed: false, reason: 'no_change' });
  }
});

for (const [currentLevel, signals, level] of [
  ['low', {}, 'medium'],
  ['low', { highRisk: true }, 'medium'],
  ['medium', { importantUncertainty: true }, 'high'],
  ['medium', { highRisk: true }, 'high'],
  ['high', { exceptionalDifficulty: true }, 'maximum'],
]) {
  test(`${currentLevel} recommends ${level} when unresolved work justifies it`, () => {
    assert.deepEqual(nextReasoningLevel({ currentLevel, unresolvedCycles: 1, ...signals }), {
      level, changed: true, reason: 'value_justifies_escalation',
    });
  });
}

test('higher reasoning recommendations require significant uncertainty or exceptional difficulty', () => {
  assert.equal(nextReasoningLevel({ currentLevel: 'medium', unresolvedCycles: 10 }).level, 'medium');
  assert.equal(nextReasoningLevel({ currentLevel: 'high', unresolvedCycles: 10, highRisk: true }).level, 'high');
  assert.equal(nextReasoningLevel({ currentLevel: 'maximum', unresolvedCycles: 10, exceptionalDifficulty: true }).level, 'maximum');
});

test('unknown or untried cycle counts do not force an escalation', () => {
  for (const unresolvedCycles of [undefined, null, 0, -1, NaN, Infinity, 'unknown', true, {}, Symbol('cycles')]) {
    assert.equal(nextReasoningLevel({ currentLevel: 'low', highRisk: true, unresolvedCycles }).level, 'low');
  }
  assert.equal(nextReasoningLevel({ currentLevel: 'low', highRisk: true, unresolvedCycles: '1' }).level, 'medium');
});

test('recent escalation holds until an explicit resolution, material risk decrease, or verified success', () => {
  const input = {
    currentLevel: 'high', importantUncertainty: false, highRisk: false,
    recentlyEscalated: true, successCriteriaSatisfied: false,
  };
  assert.deepEqual(nextReasoningLevel(input), { level: 'high', changed: false, reason: 'hysteresis_hold' });
  assert.equal(nextReasoningLevel({ ...input, successCriteriaSatisfied: true }).level, 'high');
  assert.equal(nextReasoningLevel({ ...input, uncertaintyResolved: true }).level, 'medium');
  assert.equal(nextReasoningLevel({ ...input, riskReducedMaterially: true }).level, 'medium');
  assert.equal(nextReasoningLevel({ ...input, ...verified }).level, 'medium');
});

test('unknown uncertainty or risk is not evidence for de-escalation', () => {
  for (const input of [
    {}, { importantUncertainty: false }, { highRisk: false },
    { importantUncertainty: 'false', highRisk: 'false' },
    { importantUncertainty: true, highRisk: false, uncertaintyResolved: true },
  ]) {
    assert.equal(nextReasoningLevel({ currentLevel: 'high', ...input }).level, 'high');
  }
});

test('materially reduced risk permits a one-step decrease with a low floor', () => {
  for (const [currentLevel, level] of [['maximum', 'high'], ['high', 'medium'], ['medium', 'low'], ['low', 'low']]) {
    assert.equal(nextReasoningLevel({ currentLevel, importantUncertainty: false, highRisk: false }).level, level);
  }
});

test('verified success permits de-escalation despite stale escalation hints', () => {
  assert.deepEqual(nextReasoningLevel({
    ...verified, currentLevel: 'high', recentlyEscalated: true,
    unresolvedCycles: 5, highRisk: true, exceptionalDifficulty: true,
  }), { level: 'medium', changed: true, reason: 'success_verified' });
});

test('recent de-escalation holds against minor uncertainty in both directions', () => {
  for (const currentLevel of ['low', 'medium', 'high']) {
    assert.deepEqual(nextReasoningLevel({
      currentLevel, recentlyDeescalated: true, unresolvedCycles: 1,
      importantUncertainty: false, highRisk: false,
    }), { level: currentLevel, changed: false, reason: 'hysteresis_hold' });
  }
});

test('significant new uncertainty or risk can override a recent de-escalation', () => {
  for (const signals of [{ importantUncertainty: true }, { highRisk: true }]) {
    assert.equal(nextReasoningLevel({
      currentLevel: 'low', recentlyDeescalated: true, unresolvedCycles: 1, ...signals,
    }).level, 'medium');
  }
  assert.equal(nextReasoningLevel({
    currentLevel: 'high', recentlyDeescalated: true, unresolvedCycles: 1, exceptionalDifficulty: true,
  }).level, 'maximum');
});

test('an escalation and resolution sequence does not bounce back on minor uncertainty', () => {
  const escalated = nextReasoningLevel({ currentLevel: 'low', unresolvedCycles: 1 });
  assert.equal(escalated.level, 'medium');
  const held = nextReasoningLevel({
    currentLevel: escalated.level, recentlyEscalated: true, importantUncertainty: false, highRisk: false,
  });
  assert.equal(held.level, 'medium');
  const reduced = nextReasoningLevel({
    currentLevel: held.level, recentlyEscalated: true, uncertaintyResolved: true,
    importantUncertainty: false, highRisk: false,
  });
  assert.equal(reduced.level, 'low');
  const quiet = nextReasoningLevel({
    currentLevel: reduced.level, recentlyDeescalated: true, unresolvedCycles: 1,
  });
  assert.equal(quiet.level, 'low');
  assert.equal(nextReasoningLevel({
    currentLevel: quiet.level, recentlyDeescalated: false, unresolvedCycles: 1,
  }).level, 'medium');
});

test('the governor returns deterministic guidance without mutating inputs or shared budgets', () => {
  const input = Object.freeze({
    completedCycles: 3, softCycleBudget: 3, candidateWouldProduceNewEvidence: true,
    unmetSuccessCriteria: Object.freeze(['verification']),
    currentLevel: 'medium', importantUncertainty: true, unresolvedCycles: 1,
  });
  const utility = assessUtility(input);
  utility.usefulReasons.push('caller mutation');
  assert.deepEqual(assessUtility(input), {
    decision: 'allow', usefulReasons: ['new_evidence'], wasteReasons: [], requiresJustification: true,
  });
  const budget = policyBudget('balanced', 'standard');
  budget.softCycleBudget = 100;
  assert.equal(policyBudget('balanced', 'standard').softCycleBudget, 3);
  assert.deepEqual(nextReasoningLevel(input), { level: 'high', changed: true, reason: 'value_justifies_escalation' });
  assert.deepEqual(nextReasoningLevel(input), { level: 'high', changed: true, reason: 'value_justifies_escalation' });
});
