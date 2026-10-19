import { getCompletionState, getRiskState, getStateIdentity } from './coordination-core.mjs';
import { listStateRefs, resolveStateReferences } from './state-references.mjs';
import { makeEvidenceKey, canReuseEvidence } from './evidence-cache.mjs';
import { normalizeEvidenceRecord } from './evidence-records.mjs';
import { isEligibleModel } from './model-policy.mjs';

const SOL = 'gpt-6.1-sol', ASTRA = 'gpt-6-astra';
const kinds = ['goal', 'claim', 'plan', 'evaluation', 'evidence', 'observation', 'failedStrategy',
  'checkpoint', 'adaptation', 'transfer', 'lesson', 'hypothesis', 'experiment'];
const benefitKinds = ['dependency_risk', 'stalled_strategy'];
const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const phrase = value => normalize(value).replace(/\s+/g, ' ');
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

function object(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new TypeError('Expected an object with exactly the known required/optional fields');
  }
}
function string(value) {
  if (!nonempty(value)) throw new TypeError('Expected a nonempty string');
}
function strings(value) {
  if (!Array.isArray(value)) throw new TypeError('Expected a string array');
  value.forEach(string);
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Expected a nonnegative safe revision');
}
function refs(value) {
  if (!Array.isArray(value)) throw new TypeError('Expected StateRef array');
  for (const ref of value) {
    object(ref, ['projectId', 'epoch', 'kind', 'id'], ['revision']);
    for (const key of ['projectId', 'epoch', 'id']) string(ref[key]);
    if (!kinds.includes(ref.kind)) throw new TypeError('Unsupported StateRef kind');
    if (Object.hasOwn(ref, 'revision')) revision(ref.revision);
  }
}

// Shared by the state and transport boundaries; validate JSON before property reads.
export function validateModelRoutingRequest(value, { projectId } = {}) {
  makeEvidenceKey({ params: value });
  const required = ['version', 'workUnitId', 'sourceIdentity', 'currentModel', 'userPreference',
    'forbiddenModels', 'benefit', 'nextHypothesis', 'stableBoundary', 'receiverCanResolveReferences'];
  const persisted = projectId != null;
  if (persisted) string(projectId);
  object(value, persisted ? [...required, 'operationId', 'expectedState'] : required);
  if (value.version !== 1) throw new TypeError('Unsupported model routing request version');
  string(value.workUnitId); string(value.sourceIdentity);
  if (value.currentModel !== null) string(value.currentModel);
  if (!['auto', 'sol', 'astra', 'stay'].includes(value.userPreference)) throw new TypeError('Invalid model preference');
  strings(value.forbiddenModels);
  for (const key of ['stableBoundary', 'receiverCanResolveReferences']) {
    if (typeof value[key] !== 'boolean') throw new TypeError(`${key} must be boolean`);
  }
  if (value.benefit !== null) {
    object(value.benefit, ['kind', 'reason', 'refs']);
    if (!benefitKinds.includes(value.benefit.kind)) throw new TypeError('Invalid benefit kind');
    string(value.benefit.reason); refs(value.benefit.refs);
  }
  if (value.nextHypothesis !== null) {
    object(value.nextHypothesis, ['strategyKey', 'changedEvidenceRefs', 'changedConditions', 'discriminatingCheck']);
    string(value.nextHypothesis.strategyKey); string(value.nextHypothesis.discriminatingCheck);
    refs(value.nextHypothesis.changedEvidenceRefs); strings(value.nextHypothesis.changedConditions);
  }
  if (persisted) {
    string(value.operationId);
    object(value.expectedState, ['projectId', 'epoch', 'revision']);
    string(value.expectedState.projectId); string(value.expectedState.epoch); revision(value.expectedState.revision);
    if (value.expectedState.projectId !== projectId) throw new TypeError('Expected project identity mismatch');
  }
  return structuredClone(value);
}

function resolve(project, references) {
  return project ? resolveStateReferences(project, references).references
    : references.map(reference => ({ reference, status: 'not_found', reason: 'persisted context unavailable' }));
}
const current = entry => ['current', 'unchanged'].includes(entry.status);
const causalReference = (kind, ref) => kind === 'dependency_risk'
  ? ['plan', 'goal'].includes(ref.kind) : ref.kind === 'failedStrategy';
const currentHoldReferences = entries => entries.map(entry => entry.status === 'stale'
  ? { status: 'current', record: entry.currentRecord, ref: entry.currentRef } : entry);
function freshForSource(record, sourceIdentity) {
  try {
    normalizeEvidenceRecord(record);
    return record.dependencies.includes(sourceIdentity)
      && canReuseEvidence(record, { dependencies: record.dependencies, risk: 'high' });
  } catch { return false; }
}

export function buildModelRoutingSnapshot(project, request, signals = {}) {
  validateModelRoutingRequest(request, { projectId: project?.projectId });
  const completion = project ? getCompletionState(project) : null;
  const risk = project ? getRiskState(project) : [];
  const sourceUnmetGoals = new Set();
  const unmetCriteria = (completion?.missingCriteria ?? []).map(item => `${item.goalId}: ${item.criterion}`);
  for (const item of completion?.blockers ?? []) unmetCriteria.push(`Blocker: ${item.reason}`);
  for (const item of completion?.contradictions ?? []) unmetCriteria.push(`Contradiction: ${item.claimId ?? item.evaluationId}`);
  for (const item of completion?.uncertainties ?? []) unmetCriteria.push(`Uncertainty: ${item.reason ?? item.status ?? 'unresolved assessment'}`);
  if (!project) unmetCriteria.push('Persisted criteria and source-bound verification unavailable');
  for (const goal of project?.goalGraph ?? []) {
    for (const criterion of new Set(goal.successCriteria ?? [])) {
      const assessment = project.coordination?.criteria?.find(item => item.goalId === goal.id && item.criterion === criterion);
      const sourceBound = (assessment?.evidenceIds ?? []).some(id => {
        const matches = (project.efficiency?.evidenceCache ?? []).filter(record => record.evidenceId === id);
        return matches.length === 1 && freshForSource(matches[0], request.sourceIdentity);
      });
      if (!sourceBound) {
        sourceUnmetGoals.add(goal.id);
        unmetCriteria.push(`${goal.id}: ${criterion} requires fresh evidence for ${request.sourceIdentity}`);
      }
    }
  }
  for (const key of ['importantUncertainty', 'contradictionRemaining', 'meaningfulRiskRemaining']) {
    if (signals[key] === true) unmetCriteria.push(`Reported workflow blocker: ${key}`);
  }
  if (Array.isArray(signals.unmetSuccessCriteria)) {
    unmetCriteria.push(...signals.unmetSuccessCriteria.map(item => `Reported unmet criterion: ${String(item)}`));
  }
  const uniqueUnmet = [...new Set(unmetCriteria)];
  const failedStrategies = (project?.efficiency?.failedStrategies ?? []).filter(failure => {
    const plan = project.plans?.find(item => item.id === failure.planId);
    const evaluation = project.evaluations?.find(item => item.id === failure.evaluationId && item.planId === plan?.id);
    const goalId = plan?.goalId ?? evaluation?.goalId;
    return nonempty(failure.strategyKey) && failure.status === 'failed'
      && ['blocked', 'falsified'].includes(evaluation?.outcome)
      && (completion.missingCriteria.some(item => item.goalId === goalId)
        || completion.blockers.some(item => item.goalId === goalId));
  });
  const decisions = (project?.modelRouting?.version === 1 ? project.modelRouting.decisions ?? [] : [])
    .filter(decision => decision.workUnitId === request.workUnitId && decision.sourceIdentity === request.sourceIdentity);
  const previousDecision = decisions.at(-1) ?? null;
  let holdDecision = previousDecision;
  // Traverse only this scope's unresolved revalidation chain. A resolved
  // decision ends the chain even when older holds still exist in history.
  for (let index = decisions.length - 2; index >= 0 && !holdDecision?.advice?.hold
    && holdDecision?.advice?.reasonCodes?.includes('hold_requires_revalidation'); index--) {
    holdDecision = decisions[index];
  }
  const hold = holdDecision?.advice?.hold;
  const holdRequiresRevalidation = Boolean(hold
    || previousDecision?.advice?.reasonCodes?.includes('hold_requires_revalidation'));
  const holdScoped = Boolean(hold && holdDecision.workUnitId === request.workUnitId
    && holdDecision.sourceIdentity === request.sourceIdentity && hold.workUnitId === request.workUnitId
    && hold.sourceIdentity === request.sourceIdentity && [SOL, ASTRA].includes(hold.model)
    && benefitKinds.includes(hold.triggerKind));
  let holdReferences = [];
  if (holdScoped) {
    try {
      refs(hold.triggerRefs);
      // Older v1 holds also stored supporting refs; causal kinds must still
      // resolve even when their records are missing or have changed.
      holdReferences = resolve(project, hold.triggerRefs.filter(ref => causalReference(hold.triggerKind, ref)));
    }
    catch { /* An unresolvable historical trigger cannot certify resolution. */ }
  }
  const references = project ? resolve(project, listStateRefs(project)) : [];
  const heldReferences = currentHoldReferences(holdReferences);
  const heldPlans = (project?.plans ?? []).filter(plan => heldReferences.some(entry => current(entry)
    && (entry.ref.kind === 'plan' && entry.ref.id === plan.id
      || entry.ref.kind === 'goal' && entry.ref.id === plan.goalId)));
  // Include low-risk held plans in the existing structural verifier without
  // changing their reported risk or copying the evidence/assessment rules.
  const verifiedHeldPlanIds = heldPlans.length ? getRiskState({ ...project,
    plans: heldPlans.map(plan => ({ ...plan, expectedDecisionImpact: 'high' })),
  }).filter(item => item.status === 'reported_verified').map(item => item.planId) : [];
  const snapshot = { projectId: project?.projectId ?? null, identity: project ? getStateIdentity(project) : null,
    sourceIdentity: request.sourceIdentity, workUnitId: request.workUnitId,
    completion, risk, unmetCriteria: uniqueUnmet,
    verifiedHeldPlanIds,
    supportedGoalIds: (project?.goalGraph ?? []).filter(goal => goal.successCriteria?.length
      && !sourceUnmetGoals.has(goal.id) && !completion.missingCriteria.some(item => item.goalId === goal.id)
      && !completion.blockers.some(item => item.goalId === goal.id)).map(goal => goal.id),
    goals: project?.goalGraph ?? [], plans: project?.plans ?? [], failedStrategies,
    benefitReferences: resolve(project, request.benefit?.refs ?? []),
    hypothesisReferences: resolve(project, request.nextHypothesis?.changedEvidenceRefs ?? []),
    previousDecision, hold: holdScoped ? hold : null, holdReferences, holdRequiresRevalidation,
    evidenceRefs: references.filter(current).map(entry => entry.ref),
    assessmentSource: project ? 'reported' : 'unknown' };
  snapshot.holdResolutionSupported = Boolean(snapshot.hold && heldReferences.length
    && heldReferences.every(current) && holdResolved(snapshot, snapshot.hold, heldReferences));
  if (snapshot.holdRequiresRevalidation && !snapshot.holdResolutionSupported) {
    snapshot.unmetCriteria.push('Historical hold trigger requires current source-bound supported resolution');
  }
  snapshot.completionSupported = completion?.recommended === true && snapshot.unmetCriteria.length === 0;
  return structuredClone(snapshot);
}

function unresolvedHighImpact(snapshot, entries) {
  return entries.some(entry => {
    const plans = entry.ref.kind === 'plan' ? [entry.record]
      : entry.ref.kind === 'goal' && entry.record.dependencies?.some(id =>
        snapshot.goals.find(goal => goal.id === id)?.status !== 'verified')
        ? snapshot.plans.filter(plan => plan.goalId === entry.record.id) : [];
    return plans.some(plan => (plan.risk === 'high' || plan.verificationRisk === 'high'
      || plan.expectedDecisionImpact === 'high' || plan.reversible === false)
      && nonempty(plan.action) && snapshot.risk.some(item => item.planId === plan.id && item.status === 'unknown'));
  });
}
function triggerUnresolved(snapshot, kind, entries) {
  if (kind === 'dependency_risk') return unresolvedHighImpact(snapshot, entries);
  return entries.some(entry => entry.ref.kind === 'failedStrategy'
    && snapshot.failedStrategies.some(item => item.id === entry.record.id));
}
function holdResolved(snapshot, hold, entries) {
  if (hold.triggerKind === 'dependency_risk') {
    return entries.every(entry => {
      const plans = entry.ref.kind === 'plan' ? [entry.record]
        : entry.ref.kind === 'goal' ? snapshot.plans.filter(plan => plan.goalId === entry.record.id) : [];
      return plans.length > 0 && plans.every(plan => snapshot.supportedGoalIds.includes(plan.goalId)
        && snapshot.verifiedHeldPlanIds.includes(plan.id));
    });
  }
  return entries.every(entry => entry.ref.kind === 'failedStrategy'
    && !snapshot.failedStrategies.some(item => item.id === entry.record.id)
    && snapshot.supportedGoalIds.includes(snapshot.plans.find(plan => plan.id === entry.record.planId)?.goalId))
    && snapshot.completion.contradictions.length === 0 && snapshot.completion.blockers.length === 0;
}
function distinctHypothesis(snapshot, request) {
  const hypothesis = request.nextHypothesis;
  if (!hypothesis || !snapshot.projectId || !snapshot.unmetCriteria.length
    || snapshot.failedStrategies.some(item => phrase(item.strategyKey) === phrase(hypothesis.strategyKey))) return false;
  const usedEvidence = new Set(snapshot.failedStrategies.flatMap(item => item.newEvidenceIds ?? []));
  const conditions = new Set(snapshot.failedStrategies.map(item => phrase(item.changedConditions)));
  const changedConditions = hypothesis.changedConditions.some(item => !conditions.has(phrase(item)));
  const entries = snapshot.hypothesisReferences;
  if (entries.some(entry => !current(entry))) return false;
  const changedEvidence = entries.some(entry => entry.ref.kind === 'evidence'
    && freshForSource(entry.record, request.sourceIdentity) && !usedEvidence.has(entry.record.evidenceId));
  return changedConditions || changedEvidence;
}

export function recommendModel(snapshot, request, runtime) {
  validateModelRoutingRequest(request, { projectId: snapshot.projectId });
  if (snapshot.sourceIdentity !== request.sourceIdentity || snapshot.workUnitId !== request.workUnitId) {
    throw new TypeError('Snapshot does not match the requested work unit/source');
  }
  const forbidden = request.forbiddenModels.map(normalize);
  const allowed = model => isEligibleModel(runtime.eligibility, model) && !forbidden.includes(normalize(model));
  const reportedModel = normalize(request.currentModel);
  const preference = request.userPreference === 'sol' ? SOL : request.userPreference === 'astra' ? ASTRA
    : request.userPreference === 'stay' ? reportedModel : null;
  const base = { version: 1, unmetCriteria: [...snapshot.unmetCriteria], evidenceRefs: structuredClone(snapshot.evidenceRefs),
    verificationPreserved: true, assessmentSource: snapshot.assessmentSource, advisory: true,
    executionStatus: 'not_attempted', observedModel: null, remainingVerifiedCost: null, calibration: 'not_measured' };
  function result(policyAction, recommendedModel, code, reason, hold = null, nextObservation = null) {
    const manualTransition = policyAction !== 'COMPLETE' && recommendedModel !== null && recommendedModel !== reportedModel;
    const availabilityUnresolved = manualTransition || policyAction === 'DEFER_ESCALATION';
    // Preference and authority receipts must retain unresolved verification
    // provenance even when their model advice cannot carry the prior hold.
    const preserveHoldVerification = hold === null && snapshot.holdRequiresRevalidation && !snapshot.holdResolutionSupported;
    return { ...base, action: manualTransition ? 'REQUEST_USER_CHOICE' : policyAction,
      policyAction, recommendedModel, reasonCodes: [code, 'calibration_not_measured',
        ...(preserveHoldVerification && code !== 'hold_requires_revalidation' ? ['hold_requires_revalidation'] : []),
        ...(availabilityUnresolved ? ['availability_unknown'] : []),
        ...(manualTransition ? ['manual_transition_required'] : [])],
      reasons: [reason, 'No measured comparative cost or success calibration is available.',
        ...(preserveHoldVerification ? ['The historical hold still requires supported verification; model advice does not resolve it.'] : []),
        ...(availabilityUnresolved ? ['Destination availability has not been established by the manual adapter.'] : []),
        ...(manualTransition ? ['The manual adapter requires user action for this transition.'] : [])],
      hold: structuredClone(hold), nextObservation: nextObservation ?? (manualTransition
        ? `Confirm authorized availability of ${recommendedModel} and report the active model after manual handoff.` : null) };
  }
  const choice = (code, reason, observation) => result('REQUEST_USER_CHOICE', null, code, reason, null, observation);
  if (request.userPreference !== 'auto' && (!preference || !allowed(preference))) {
    return choice('preference_ineligible', 'The stated model preference conflicts with eligibility or lacks a reported current model.',
      'Provide an eligible model preference or explicitly revise operator restrictions.');
  }
  if (![SOL, ASTRA].some(allowed) && !preference) {
    return choice('no_eligible_destination', 'Neither routing destination is authorized.', 'Confirm an operator-authorized destination.');
  }
  if (reportedModel && !allowed(reportedModel)) {
    return choice('reported_model_ineligible', 'The reported current model is unknown or conflicts with current restrictions.',
      'Report an eligible active model and reconcile the current operator policy.');
  }
  if (snapshot.completionSupported && reportedModel && allowed(reportedModel)) {
    return result('COMPLETE', null, 'supported_source_completion',
      'Registered completion support is current, source-bound, and has no unresolved required checks, contradictions or risk.');
  }
  if (preference) {
    const action = preference === ASTRA ? 'KEEP_ASTRA' : preference === SOL ? 'KEEP_SOL' : 'REQUEST_USER_CHOICE';
    return result(action, preference, 'explicit_preference',
      'The eligible explicit preference takes precedence; all outstanding verification remains required.', null,
      action === 'REQUEST_USER_CHOICE'
        ? 'Confirm the intended eligible custom model and register the outstanding source-bound verification.' : null);
  }
  if (snapshot.holdRequiresRevalidation) {
    // A stale exact version is not evidence; explicitly reassess the resolver's
    // current version instead, retaining only its canonical current reference.
    const entries = currentHoldReferences(snapshot.holdReferences);
    if (!entries.length || entries.some(entry => !current(entry))) {
      return result('DEFER_ESCALATION', null, 'hold_requires_revalidation',
        'The previous trigger is unavailable or stale; a stable boundary cannot establish its resolution.', null,
        'Resolve the current trigger references and register supported resolution or remaining risk.');
    }
    if (allowed(snapshot.hold.model)
      && (!snapshot.holdResolutionSupported || !request.stableBoundary)) {
      const held = { ...snapshot.hold, triggerRefs: entries.map(entry => entry.ref) };
      return result(held.model === ASTRA ? 'KEEP_ASTRA' : 'KEEP_SOL', held.model, 'scoped_hold',
        'Retain the recommendation for this work unit/source until the trigger is resolved at a stable boundary.', held,
        'Register source-bound criterion support and a supported trigger resolution at a stable boundary.');
    }
  }
  if (request.benefit) {
    const entries = snapshot.benefitReferences;
    const evidenced = entries.length > 0 && entries.every(current)
      && triggerUnresolved(snapshot, request.benefit.kind, entries);
    if (evidenced) {
      if (!allowed(ASTRA)) return choice('astra_ineligible',
        'The concrete benefit cannot authorize Astra under current restrictions.',
        'Choose an eligible strategy or explicitly revise the model restriction.');
      const hold = { model: ASTRA, workUnitId: request.workUnitId, sourceIdentity: request.sourceIdentity,
        triggerKind: request.benefit.kind, triggerRefs: entries
          .filter(entry => triggerUnresolved(snapshot, request.benefit.kind, [entry])).map(entry => entry.ref) };
      return result('ESCALATE_ASTRA', ASTRA, 'evidenced_benefit',
        `Astra could improve this unresolved decision: ${request.benefit.reason}`, hold);
    }
    return result('DEFER_ESCALATION', null, 'benefit_not_established',
      'Current references do not establish a useful unresolved dependency or blocked strategy benefit.', null,
      'Register current high-impact dependency/action references or a recorded strategy failure blocking a required criterion.');
  }
  if (distinctHypothesis(snapshot, request)) {
    if (!allowed(SOL)) return choice('sol_ineligible', 'The distinct Sol hypothesis requires an unauthorized destination.',
      'Choose an eligible model for the discriminating check.');
    return result('SOL_RETRY_WITH_NEW_EVIDENCE', SOL, 'distinct_evidenced_hypothesis',
      `Test ${request.nextHypothesis.strategyKey} against the unmet criteria: ${request.nextHypothesis.discriminatingCheck}`);
  }
  if (snapshot.failedStrategies.length || request.nextHypothesis) {
    return choice('no_supported_retry', 'No distinct evidenced hypothesis or authorized escalation resolves the recorded failure.',
      'Supply a different strategy with new evidence or concrete changed conditions and a check for an unmet criterion.');
  }
  if (reportedModel === ASTRA && allowed(ASTRA) && !request.stableBoundary) {
    return result('KEEP_ASTRA', ASTRA, 'await_stable_boundary',
      'Retain the reported model until a stable boundary permits a coherent handoff.');
  }
  const routineModel = allowed(SOL) ? SOL : ASTRA;
  return result(routineModel === SOL ? 'KEEP_SOL' : 'KEEP_ASTRA', routineModel, 'adequate_routine_work',
    'Continue adequate routine work on an eligible model; no concrete incremental escalation benefit is established.');
}
