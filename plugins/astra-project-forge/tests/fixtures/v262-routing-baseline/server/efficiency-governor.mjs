export const EFFICIENCY_POLICIES = Object.freeze(['eco', 'balanced', 'performance', 'maximum']);
export const REASONING_LEVELS = Object.freeze(['low', 'medium', 'high', 'maximum']);

const budgets = {
  eco: { off: 0, light: 1, standard: 1, deep: 2 },
  balanced: { off: 0, light: 1, standard: 3, deep: 3 },
  performance: { off: 0, light: 1, standard: 3, deep: 5 },
  maximum: { off: 0, light: 1, standard: 4, deep: 6 },
};

const asInput = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const nonNegativeNumber = (value, fallback) => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
};

export function normalizeEfficiencyPolicy(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return EFFICIENCY_POLICIES.includes(normalized) ? normalized : 'balanced';
}

export function policyBudget(policyInput, routeProfile = 'standard') {
  const policy = normalizeEfficiencyPolicy(policyInput);
  const route = ['off', 'light', 'standard', 'deep'].includes(routeProfile) ? routeProfile : 'standard';
  return {
    softCycleBudget: budgets[policy][route],
    contextPreference: policy === 'eco' ? 'summary' : 'working',
  };
}

export function shouldComplete(input = {}) {
  input = asInput(input);
  return input.successCriteriaSatisfied === true
    && input.evidenceSufficient === true
    && input.contradictionRemaining === false
    && input.meaningfulRiskRemaining === false;
}

export function assessUtility(input = {}) {
  input = asInput(input);
  if (shouldComplete(input)) {
    return { decision: 'stop', usefulReasons: [], wasteReasons: ['success_verified'], requiresJustification: false };
  }

  // These flags describe meaningful outcomes of this candidate. Project-wide
  // unmet criteria, uncertainty, risk, or blockers alone do not establish value.
  const usefulReasons = [
    ['candidateWouldVerifySuccessCriterion', 'unmet_success_criterion'],
    ['candidateWouldResolveUncertainty', 'important_uncertainty'],
    ['candidateWouldReduceRisk', 'high_risk_verification'],
    ['candidateWouldResolveContradiction', 'contradictory_evidence'],
    ['candidateWouldProduceNewEvidence', 'new_evidence'],
    ['candidateWouldChangeDecision', 'decision_impact'],
    ['candidateWouldDetectFailure', 'meaningful_failure_detection'],
    ['candidateWouldUnblockDependency', 'blocked_goal'],
    ['candidateWouldMakeProgress', 'goal_progress'],
  ].filter(([flag]) => input[flag] === true).map(([, reason]) => reason);
  if (input.newEvidenceRequiresReplan === true && input.candidateWouldReplan === true) {
    usefulReasons.push('new_evidence_requires_replan');
  }

  const independentValue = input.candidateHasIndependentValue === true && usefulReasons.length > 0;
  const wasteReasons = [
    [input.duplicateValidEvidence === true && !independentValue, 'duplicate_valid_evidence'],
    [input.repeatsFailedStrategyWithoutNewEvidence === true, 'repeated_failed_strategy'],
    [input.irrelevantContextReload === true, 'irrelevant_context'],
    [input.noExpectedDecisionImpact === true, 'no_expected_decision_impact'],
    [input.alreadySufficientlyVerified === true, 'already_sufficiently_verified'],
    [input.duplicateConcurrentAction === true && !independentValue, 'duplicate_concurrent_action'],
  ].filter(([wasteful]) => wasteful).map(([, reason]) => reason);

  // Explicit waste assessments take precedence over conflicting value hints.
  if (wasteReasons.length) {
    return { decision: 'skip', usefulReasons, wasteReasons, requiresJustification: false };
  }
  const reachedBudget = nonNegativeNumber(input.completedCycles, 0)
    >= nonNegativeNumber(input.softCycleBudget, Infinity);
  return {
    decision: usefulReasons.length || !reachedBudget ? 'allow' : 'justify',
    usefulReasons,
    wasteReasons,
    requiresJustification: reachedBudget,
  };
}

// Returns guidance only: changed compares the recommendation to currentLevel.
// The caller tracks recency/resolution signals; this never sets host effort.
export function nextReasoningLevel(input = {}) {
  input = asInput(input);
  const current = REASONING_LEVELS.includes(input.currentLevel) ? input.currentLevel : 'low';
  const index = REASONING_LEVELS.indexOf(current);
  const recommend = (nextIndex, reason) => {
    const level = REASONING_LEVELS[Math.max(0, Math.min(nextIndex, REASONING_LEVELS.length - 1))];
    return { level, changed: level !== current, reason };
  };

  if (shouldComplete(input)) return recommend(index - 1, 'success_verified');

  const exceptional = input.exceptionalDifficulty === true;
  const significant = input.importantUncertainty === true || input.highRisk === true || exceptional;
  if (input.recentlyDeescalated === true && !significant) {
    return recommend(index, 'hysteresis_hold');
  }

  const unresolved = nonNegativeNumber(input.unresolvedCycles, 0) >= 1;
  if (unresolved && (index === 0 || (index === 1 && significant) || (index === 2 && exceptional))) {
    return recommend(index + 1, 'value_justifies_escalation');
  }

  if (input.recentlyEscalated === true && input.uncertaintyResolved !== true && input.riskReducedMaterially !== true) {
    return recommend(index, 'hysteresis_hold');
  }
  if (index > 0 && input.importantUncertainty === false && input.highRisk === false && !exceptional) {
    return recommend(index - 1, 'risk_reduced');
  }
  return recommend(index, 'no_change');
}
