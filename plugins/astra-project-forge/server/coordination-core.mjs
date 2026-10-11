import { createHash } from 'node:crypto';
import { makeEvidenceKey, canReuseEvidence, invalidateByChangedDependency } from './evidence-cache.mjs';
import { normalizeEvidenceRecord, upsertEvidence } from './evidence-records.mjs';
import { applyEfficiencyEvent } from './efficiency-ledger.mjs';
import { recordRevision, latestRecordRevision, stampChangedRecords, requireString,
  createEvaluationRecord, createFailedStrategyRecord, updateClaimRecord } from './agent-state.mjs';

// The evidence canonicalizer rejects getters, cycles and lossy non-JSON values.
const digest = value => makeEvidenceKey({ params: value });
const contentDigest = record => {
  const { revision, ...content } = record;
  return digest(content);
};
const declarations = goal => digest([...new Set(goal.successCriteria ?? [])].sort());
export function getStateIdentity(project) {
  const epoch = project.coordination?.epoch ?? `legacy-${createHash('sha256')
    .update(JSON.stringify([project.projectId, project.createdAt ?? null])).digest('hex')}`;
  return { projectId: project.projectId, epoch, revision: recordRevision(project) };
}

function evidenceById(project, id) {
  const matches = (project.efficiency?.evidenceCache ?? []).filter(record => record.evidenceId === id);
  if (matches.length !== 1) throw new TypeError(`Evidence ID ${id} is missing or ambiguous`);
  normalizeEvidenceRecord(matches[0]);
  return matches[0];
}
function supported(project, assessment) {
  if (!assessment || assessment.satisfied !== true || !assessment.evidenceIds?.length) return false;
  try {
    return assessment.evidenceIds.every(id => {
      const record = evidenceById(project, id);
      return canReuseEvidence(record, { dependencies: record.dependencies, risk: 'high' })
        && assessment.evidenceDigests?.[id] === contentDigest(record);
    });
  } catch { return false; }
}

// Support belongs to an explicit claim assessment, not to later metadata edits.
// Keep additive pins in coordination metadata so legacy claim wrappers stay stable.
export function assessClaimSupport(project, claim, patch) {
  if (patch?.status !== 'known' && patch?.evidenceIds == null) return;
  project.coordination ??= { epoch: getStateIdentity(project).epoch, operations: {}, criteria: [] };
  const assessments = project.coordination.claimAssessments ??= [];
  const index = assessments.findIndex(item => item.claimId === claim.id);
  const evidenceDigests = Object.create(null);
  if (claim.status === 'known') for (const id of claim.evidenceIds ?? []) {
    try { evidenceDigests[id] = contentDigest(evidenceById(project, id)); }
    catch { /* Legacy writes accept external/missing evidence; completion stays unknown. */ }
  }
  const assessment = { claimId: claim.id, statementDigest: digest(claim.statement),
    evidenceDigests, assessedRevision: latestRecordRevision(project) + 1 };
  if (index < 0) assessments.push(assessment); else assessments[index] = assessment;
}

function applicableEvaluations(project) {
  const goals = project.goalGraph ?? [];
  const latest = new Map();
  for (const evaluation of project.evaluations ?? []) {
    if (evaluation.assessmentScope === 'project') {
      // Only an explicitly complete fused reassessment can supersede earlier
      // ambiguous/unassociated attempts. Replay never appends an evaluation.
      for (const scope of latest.keys()) if (scope.startsWith('unknown:') || scope.startsWith('plan:')) latest.delete(scope);
    }
    const plan = project.plans?.find(item => item.id === evaluation.planId);
    const goalId = evaluation.goalId ?? plan?.goalId;
    const ambiguous = (evaluation.planId && !plan)
      || (evaluation.goalId && plan?.goalId && evaluation.goalId !== plan.goalId)
      || (goalId && !goals.some(goal => goal.id === goalId));
    // An unassociated plan can only supersede itself. A bare single-goal
    // assessment has one possible scope; multi-goal/ambiguous records cannot
    // establish a scope and cannot erase another record's unresolved result.
    const scope = ambiguous ? `unknown:${evaluation.id}` : goalId ? `goal:${goalId}`
      : plan ? `plan:${plan.id}` : goals.length === 1 ? `goal:${goals[0].id}` : `unknown:${evaluation.id}`;
    latest.set(scope, evaluation);
  }
  return latest.values();
}

export function invalidateChangedCriteria(project, previous) {
  if (!previous || !project.coordination?.criteria) return;
  project.coordination.criteria = project.coordination.criteria.filter(assessment => {
    const goal = project.goalGraph.find(item => item.id === assessment.goalId);
    const oldGoal = previous.goalGraph?.find(item => item.id === assessment.goalId);
    return goal && (!oldGoal || declarations(goal) === declarations(oldGoal) || assessment.criteriaDigest === declarations(goal));
  });
}

// Action risk remains visible after verification. This checks only a reported
// plan evaluation and its structural evidence/criteria support, not safety truth.
export function getRiskState(project) {
  return (project.plans ?? []).filter(plan => plan.risk !== 'low' || plan.verificationRisk !== 'low'
    || plan.reversible === false || plan.expectedDecisionImpact === 'high').map(plan => {
    const evaluation = (project.evaluations ?? []).findLast(record => record.planId === plan.id);
    const goal = (project.goalGraph ?? []).find(record => record.id === plan.goalId);
    const criteria = [...new Set(goal?.successCriteria ?? [])];
    let verified = false;
    try {
      verified = Boolean(goal && criteria.length && criteria.every(criterion => {
        const assessment = project.coordination?.criteria?.find(record => record.goalId === goal.id && record.criterion === criterion);
        return supported(project, assessment) && assessment.criteriaDigest === declarations(goal);
      }) && evaluation?.outcome === 'verified' && !evaluation.missingCriteria?.length
        && evaluation.evidenceIds?.length && evaluation.evidenceIds.every(id => {
          const record = evidenceById(project, id);
          // A fresh same-ID replacement is not evidence that this older
          // evaluation assessed. Changed content requires explicit reevaluation.
          return recordRevision(record) <= recordRevision(evaluation)
            && canReuseEvidence(record, { dependencies: record.dependencies, risk: 'high' });
        }));
    } catch { verified = false; }
    return { planId: plan.id, goalId: plan.goalId ?? null, risk: plan.risk ?? 'unknown',
      verificationRisk: plan.verificationRisk ?? 'unknown', reversible: plan.reversible ?? null,
      status: verified ? 'reported_verified' : 'unknown', assessmentSource: 'reported',
      reason: verified ? 'explicit plan evaluation with supported current criteria and evidence' : 'missing or unsupported plan risk verification',
      evaluationId: evaluation?.id ?? null, evidenceIds: evaluation?.evidenceIds ?? [] };
  });
}

export function getCompletionState(project) {
  const missingCriteria = [], blockers = [], contradictions = [], uncertainties = [];
  const goals = project.goalGraph ?? [];
  let count = 0;
  for (const goal of goals) {
    if (goal.status === 'abandoned') { blockers.push({ goalId: goal.id, reason: 'abandoned' }); }
    if (goal.status === 'blocked') blockers.push({ goalId: goal.id, reason: 'blocked' });
    for (const dependency of goal.dependencies ?? []) {
      if (goals.find(item => item.id === dependency)?.status !== 'verified') {
        blockers.push({ goalId: goal.id, dependencyId: dependency, reason: 'unresolved dependency' });
      }
    }
    const criteria = [...new Set(goal.successCriteria ?? [])];
    if (!criteria.length) uncertainties.push({ goalId: goal.id, reason: 'no registered criteria' });
    for (const criterion of criteria) {
      count++;
      const assessment = project.coordination?.criteria?.find(item => item.goalId === goal.id && item.criterion === criterion);
      if (!supported(project, assessment) || assessment?.criteriaDigest !== declarations(goal)) {
        missingCriteria.push({ goalId: goal.id, criterion, satisfied: assessment?.satisfied ?? null,
          reason: !assessment ? 'unevaluated' : assessment.satisfied === false ? 'unsatisfied' : 'unsupported or stale assessment' });
      }
    }
  }
  for (const claim of project.claims ?? []) {
    if (claim.status === 'contradicted' || claim.counterEvidenceIds?.length) contradictions.push({ claimId: claim.id, status: claim.status, counterEvidenceIds: claim.counterEvidenceIds ?? [] });
    if (['unknown', 'inferred'].includes(claim.status)) uncertainties.push({ claimId: claim.id, status: claim.status });
    if (claim.status === 'known') {
      const assessment = project.coordination?.claimAssessments?.find(item => item.claimId === claim.id);
      try {
        if (assessment?.statementDigest !== digest(claim.statement) || !claim.evidenceIds?.length || !claim.evidenceIds.every(id => {
          const record = evidenceById(project, id);
          return canReuseEvidence(record, { dependencies: record.dependencies, risk: 'high' })
            && assessment.evidenceDigests?.[id] === contentDigest(record)
            && recordRevision(record) <= assessment.assessedRevision;
        })) uncertainties.push({ claimId: claim.id, reason: 'unsupported claim' });
      } catch { uncertainties.push({ claimId: claim.id, reason: 'unsupported claim' }); }
    }
  }
  for (const evaluation of applicableEvaluations(project)) {
    if (evaluation.outcome === 'blocked') blockers.push({ evaluationId: evaluation.id, reason: 'blocked evaluation' });
    if (evaluation.outcome === 'falsified') contradictions.push({ evaluationId: evaluation.id, reason: 'falsified evaluation' });
    if (['inconclusive', 'partially_verified'].includes(evaluation.outcome)) uncertainties.push({ evaluationId: evaluation.id, reason: evaluation.outcome });
    if (evaluation.missingCriteria?.length) uncertainties.push({ evaluationId: evaluation.id, missingCriteria: evaluation.missingCriteria });
  }
  if (!count) uncertainties.push({ reason: 'no registered criteria' });
  // The schema has no materiality marker: retain explicit current uncertainties
  // conservatively. New checkpoints/consolidations supersede their older lists.
  const checkpoint = project.checkpoints?.at(-1);
  uncertainties.push(...(checkpoint?.remainingUnknowns ?? []).map(reason => ({ checkpointId: checkpoint.id, reason })));
  uncertainties.push(...(project.consolidation?.remainingUncertainty ?? []).map(reason => ({ reason, source: 'consolidation' })));
  uncertainties.push(...(project.hypotheses ?? []).filter(record => record.status === 'open')
    .map(record => ({ hypothesisId: record.id, reason: record.hypothesis })));
  const risk = getRiskState(project);
  uncertainties.push(...risk.filter(item => item.status === 'unknown').map(item => ({ planId: item.planId, reason: 'unresolved risk' })));
  return { recommended: count > 0 && !missingCriteria.length && !blockers.length && !contradictions.length && !uncertainties.length,
    missingCriteria, blockers, contradictions, uncertainties, risk, assessmentSource: 'reported' };
}

function list(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return value;
}
function ids(value, name) {
  const values = list(value, name);
  if (values.some(id => typeof id !== 'string' || !id.trim())) throw new TypeError(`${name} must contain non-empty strings`);
  return [...new Set(values)];
}
function references(project) {
  const { projectId, epoch } = getStateIdentity(project);
  const sections = [['goal', project.goalGraph], ['claim', project.claims], ['evaluation', project.evaluations],
    ['evidence', project.efficiency.evidenceCache], ['failedStrategy', project.efficiency.failedStrategies]];
  return sections.flatMap(([kind, records]) => records.filter(record => record.revision === project.revision).map(record =>
    ({ projectId, epoch, kind, id: kind === 'evidence' ? record.key : record.id, revision: recordRevision(record) })));
}
function conflict(message, code, project) {
  const error = new Error(message);
  error.code = code; error.identity = getStateIdentity(project);
  return error;
}
export function coordinateTransition(project, input, { noCommit }) {
  const operationDigest = digest(input); // Validate before reading any caller properties.
  const request = input.coordination;
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('coordination must be an object');
  const operationId = requireString(request.operationId, 'operationId');
  if (request.stateEpoch !== getStateIdentity(project).epoch) throw conflict('State epoch/generation conflict', 'STATE_EPOCH_CONFLICT', project);
  const operations = project.coordination?.operations ?? {};
  if (Object.hasOwn(operations, operationId)) {
    const operation = operations[operationId];
    if (operation.digest !== operationDigest) throw new Error('Operation ID reused with different payload digest');
    return noCommit({ ...structuredClone(operation.response), replayed: true });
  }
  recordRevision({ revision: request.expectedRevision });
  if (request.expectedRevision !== project.revision) throw conflict('Expected revision conflict', 'REVISION_CONFLICT', project);
  const previous = structuredClone(project);
  project.coordination ??= { epoch: getStateIdentity(project).epoch, operations: {}, criteria: [] };
  for (const record of list(request.evidenceRecords, 'evidenceRecords')) upsertEvidence(project, normalizeEvidenceRecord(record));
  if (request.changedDependencyIds !== undefined) project.efficiency.evidenceCache = invalidateByChangedDependency(project.efficiency.evidenceCache, request.changedDependencyIds);
  const mappedGoals = new Set();
  for (const update of list(request.criteriaUpdates, 'criteriaUpdates')) {
    const goal = project.goalGraph.find(item => item.id === update.goalId);
    if (!goal || !goal.successCriteria.includes(update.criterion)) throw new TypeError('Unknown goal/criterion mapping');
    if (typeof update.satisfied !== 'boolean') throw new TypeError('Criterion satisfied must be boolean');
    const evidenceIds = ids(update.evidenceIds, 'evidenceIds');
    const evidenceDigests = Object.create(null);
    for (const id of evidenceIds) evidenceDigests[id] = contentDigest(evidenceById(project, id));
    const assessment = { goalId: goal.id, criterion: update.criterion, satisfied: update.satisfied,
      evidenceIds, evidenceDigests, criteriaDigest: declarations(goal), assessmentSource: 'reported' };
    const index = project.coordination.criteria.findIndex(item => item.goalId === goal.id && item.criterion === update.criterion);
    if (index < 0) project.coordination.criteria.push(assessment); else project.coordination.criteria[index] = assessment;
    mappedGoals.add(goal.id);
  }
  for (const update of list(request.claimUpdates, 'claimUpdates')) {
    const claim = project.claims.find(item => item.id === update.claimId);
    if (!claim) throw new TypeError('Unknown claim mapping');
    for (const field of ['evidenceIds', 'counterEvidenceIds']) {
      if (Object.hasOwn(update, field)) for (const id of ids(update[field], field)) evidenceById(project, id);
    }
    updateClaimRecord(claim, update);
    if (claim.status === 'known') for (const id of claim.evidenceIds) {
      const record = evidenceById(project, id);
      if (!canReuseEvidence(record, { dependencies: record.dependencies, risk: 'high' })) throw new TypeError('Known claim requires fresh evidence');
    }
    assessClaimSupport(project, claim, update);
    claim.assessmentSource = 'reported';
  }
  for (const field of ['goalId', 'planId']) {
    const records = field === 'goalId' ? project.goalGraph : project.plans;
    if (input[field] != null && !records.some(record => record.id === input[field])) throw new TypeError(`Unknown evaluation ${field}`);
  }
  const evaluation = createEvaluationRecord(input);
  for (const id of evaluation.evidenceIds) evidenceById(project, id);
  evaluation.assessmentSource = 'reported';
  // Existing assessments alone cannot turn an unrelated success into project
  // recovery. This request must explicitly reassess every declared criterion.
  const updates = list(request.criteriaUpdates, 'criteriaUpdates');
  if (evaluation.outcome === 'verified' && !evaluation.missingCriteria.length
    && project.goalGraph.length && project.goalGraph.every(goal => {
      const criteria = [...new Set(goal.successCriteria ?? [])];
      return criteria.length && criteria.every(criterion => {
        const update = updates.findLast(item => item.goalId === goal.id && item.criterion === criterion);
        const assessment = project.coordination.criteria.find(item => item.goalId === goal.id && item.criterion === criterion);
        return update?.satisfied === true && supported(project, assessment);
      });
    })) evaluation.assessmentScope = 'project';
  project.evaluations.push(evaluation);
  const plan = project.plans.find(item => item.id === evaluation.planId);
  if (plan?.strategyKey && ['falsified', 'blocked'].includes(evaluation.outcome)) project.efficiency.failedStrategies.push(createFailedStrategyRecord(plan, evaluation));
  for (const goal of project.goalGraph.filter(item => mappedGoals.has(item.id))) {
    const criteria = [...new Set(goal.successCriteria)];
    const complete = criteria.length > 0 && criteria.every(criterion => supported(project,
      project.coordination.criteria.find(item => item.goalId === goal.id && item.criterion === criterion)))
      && (goal.dependencies ?? []).every(id => project.goalGraph.find(item => item.id === id)?.status === 'verified');
    if (complete && !['blocked', 'abandoned'].includes(goal.status)) {
      goal.status = 'verified';
      goal.evidenceIds = [...new Set(project.coordination.criteria.filter(item => item.goalId === goal.id).flatMap(item => item.evidenceIds))];
    } else if (!complete && goal.status === 'verified') goal.status = 'active';
  }
  for (const event of list(request.efficiencyEvents, 'efficiencyEvents')) {
    if (event.provenance?.source !== 'reported') throw new TypeError('External efficiency events must have reported provenance');
    if (Object.hasOwn(event, 'revision')) throw new TypeError('Event revisions are store-managed');
    project.efficiency.ledger = applyEfficiencyEvent(project.efficiency.ledger, event);
  }
  const revision = latestRecordRevision(project) + 1;
  recordRevision({ revision });
  const responseProject = structuredClone(project);
  stampChangedRecords(responseProject, previous, revision);
  // #write owns persistence and revision advancement; predict its exact result.
  responseProject.revision = revision;
  const response = { evaluation: structuredClone(responseProject.evaluations.at(-1)), identity: getStateIdentity(responseProject),
    completion: getCompletionState(responseProject), changed: true, refs: references(responseProject), replayed: false };
  Object.defineProperty(project.coordination.operations, operationId, { enumerable: true, writable: true, configurable: true,
    value: { digest: operationDigest, response: structuredClone(response) } });
  return response;
}
