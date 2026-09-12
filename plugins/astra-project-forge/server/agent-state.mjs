import { randomUUID } from 'node:crypto';

export const GOAL_STATUSES = ['pending', 'active', 'blocked', 'verified', 'abandoned'];
export const CLAIM_STATUSES = ['known', 'inferred', 'unknown', 'contradicted'];
export const EVALUATION_OUTCOMES = ['verified', 'partially_verified', 'inconclusive', 'falsified', 'blocked'];
export const FAILURE_CATEGORIES = [
  'wrong_hypothesis',
  'missing_information',
  'implementation_defect',
  'evaluation_defect',
  'environment_tooling_issue',
  'misunderstood_requirement',
  'permission_limitation',
  'performance_resource_limitation',
  'conflicting_evidence',
  'external_dependency'
];
export const USAGE_IMPACTS = ['MINIMAL', 'LOW', 'MODERATE', 'HIGH', 'VERY HIGH'];

const now = () => new Date().toISOString();
const makeId = prefix => `${prefix}-${randomUUID()}`;

export function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

export function stringArray(value, name) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw new Error(`${name} must be an array of strings`);
  return value.map(v => v.trim()).filter(Boolean);
}

export function confidenceValue(value) {
  if (value == null) return null;
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0 || value > 1) throw new Error('confidence must be a number between 0 and 1');
  return value;
}

export function createGoalRecord(input, goals) {
  const parentId = input?.parentId == null ? null : requireString(input.parentId, 'parentId');
  if (parentId && !goals.some(goal => goal.id === parentId)) throw new Error(`Parent goal not found: ${parentId}`);
  const dependencies = stringArray(input?.dependencies, 'dependencies');
  for (const dependency of dependencies) {
    if (!goals.some(goal => goal.id === dependency)) throw new Error(`Goal dependency not found: ${dependency}`);
  }
  const blocked = dependencies.some(id => goals.find(goal => goal.id === id)?.status !== 'verified');
  const timestamp = now();
  return {
    id: makeId('goal'),
    parentId,
    title: requireString(input?.title, 'title'),
    description: input?.description == null ? requireString(input?.title, 'title') : requireString(input.description, 'description'),
    status: blocked ? 'blocked' : 'pending',
    priority: Number.isFinite(input?.priority) ? Math.max(0, Math.min(100, Math.round(input.priority))) : 50,
    dependencies,
    successCriteria: stringArray(input?.successCriteria, 'successCriteria'),
    evidenceIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function updateGoalRecord(goal, patch, goals) {
  if (!goal) throw new Error('Goal not found');
  if (patch?.title != null) goal.title = requireString(patch.title, 'title');
  if (patch?.description != null) goal.description = requireString(patch.description, 'description');
  if (patch?.priority != null) {
    if (!Number.isFinite(patch.priority)) throw new Error('priority must be a number');
    goal.priority = Math.max(0, Math.min(100, Math.round(patch.priority)));
  }
  if (patch?.successCriteria != null) goal.successCriteria = stringArray(patch.successCriteria, 'successCriteria');
  if (patch?.dependencies != null) {
    const dependencies = stringArray(patch.dependencies, 'dependencies');
    for (const dependency of dependencies) {
      if (!goals.some(item => item.id === dependency)) throw new Error(`Goal dependency not found: ${dependency}`);
      if (dependency === goal.id) throw new Error('Goal cannot depend on itself');
    }
    goal.dependencies = dependencies;
  }
  if (patch?.status != null) {
    if (!GOAL_STATUSES.includes(patch.status)) throw new Error(`status must be one of: ${GOAL_STATUSES.join(', ')}`);
    if (patch.status === 'verified') {
      const evidenceIds = stringArray(patch.evidenceIds, 'evidenceIds');
      if (!evidenceIds.length) throw new Error('evidenceIds are required before a goal can be verified');
      goal.evidenceIds = evidenceIds;
    }
    goal.status = patch.status;
  }
  goal.updatedAt = now();
  return goal;
}

export function refreshBlockedGoals(goals) {
  for (const goal of goals) {
    if (!goal.dependencies?.length || goal.status === 'verified' || goal.status === 'abandoned') continue;
    const unresolved = goal.dependencies.some(id => goals.find(item => item.id === id)?.status !== 'verified');
    if (unresolved) goal.status = 'blocked';
    else if (goal.status === 'blocked') goal.status = 'pending';
  }
  return goals;
}

export function createClaimRecord(input) {
  const status = input?.status ?? 'inferred';
  if (!CLAIM_STATUSES.includes(status)) throw new Error(`status must be one of: ${CLAIM_STATUSES.join(', ')}`);
  const evidenceIds = stringArray(input?.evidenceIds, 'evidenceIds');
  const counterEvidenceIds = stringArray(input?.counterEvidenceIds, 'counterEvidenceIds');
  if (status === 'known' && evidenceIds.length === 0) throw new Error('Known claims require at least one evidenceId');
  const scope = input?.scope ?? 'project';
  if (!['project', 'goal', 'task'].includes(scope)) throw new Error('scope must be project, goal, or task');
  const timestamp = now();
  return {
    id: makeId('claim'),
    statement: requireString(input?.statement, 'statement'),
    status,
    confidence: confidenceValue(input?.confidence),
    evidenceIds,
    counterEvidenceIds,
    scope,
    scopeId: input?.scopeId == null ? null : requireString(input.scopeId, 'scopeId'),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function updateClaimRecord(claim, patch) {
  if (!claim) throw new Error('Claim not found');
  if (patch?.statement != null) claim.statement = requireString(patch.statement, 'statement');
  if (patch?.confidence != null) claim.confidence = confidenceValue(patch.confidence);
  if (patch?.evidenceIds != null) claim.evidenceIds = stringArray(patch.evidenceIds, 'evidenceIds');
  if (patch?.counterEvidenceIds != null) claim.counterEvidenceIds = stringArray(patch.counterEvidenceIds, 'counterEvidenceIds');
  if (patch?.status != null) {
    if (!CLAIM_STATUSES.includes(patch.status)) throw new Error(`status must be one of: ${CLAIM_STATUSES.join(', ')}`);
    if (patch.status === 'known' && !(patch.evidenceIds ?? claim.evidenceIds)?.length) throw new Error('Known claims require at least one evidenceId');
    claim.status = patch.status;
  }
  claim.updatedAt = now();
  return claim;
}

export function createPlanRecord(input) {
  const usageImpact = input?.usageImpact ?? 'LOW';
  if (!USAGE_IMPACTS.includes(usageImpact)) throw new Error(`usageImpact must be one of: ${USAGE_IMPACTS.join(', ')}`);
  const risk = input?.risk ?? 'low';
  if (!['low', 'medium', 'high'].includes(risk)) throw new Error('risk must be low, medium, or high');
  return {
    id: makeId('plan'),
    goalId: input?.goalId == null ? null : requireString(input.goalId, 'goalId'),
    action: requireString(input?.action, 'action'),
    why: requireString(input?.why, 'why'),
    expectedEvidence: input?.expectedEvidence == null ? null : requireString(input.expectedEvidence, 'expectedEvidence'),
    risk,
    reversible: input?.reversible !== false,
    usageImpact,
    status: 'planned',
    createdAt: now(),
  };
}

export function createEvaluationRecord(input) {
  const outcome = input?.outcome ?? 'inconclusive';
  if (!EVALUATION_OUTCOMES.includes(outcome)) throw new Error(`outcome must be one of: ${EVALUATION_OUTCOMES.join(', ')}`);
  return {
    id: makeId('eval'),
    goalId: input?.goalId == null ? null : requireString(input.goalId, 'goalId'),
    planId: input?.planId == null ? null : requireString(input.planId, 'planId'),
    outcome,
    summary: requireString(input?.summary, 'summary'),
    evidenceIds: stringArray(input?.evidenceIds, 'evidenceIds'),
    missingCriteria: stringArray(input?.missingCriteria, 'missingCriteria'),
    createdAt: now(),
  };
}

export function createAdaptationRecord(input, previousAdaptations = []) {
  const category = input?.failureCategory;
  if (!FAILURE_CATEGORIES.includes(category)) throw new Error(`failureCategory must be one of: ${FAILURE_CATEGORIES.join(', ')}`);
  const failedAction = requireString(input?.failedAction, 'failedAction');
  const nextStrategy = requireString(input?.nextStrategy, 'nextStrategy');
  const newEvidenceIds = stringArray(input?.newEvidenceIds, 'newEvidenceIds');
  if (failedAction === nextStrategy && newEvidenceIds.length === 0) throw new Error('nextStrategy must materially change after failure unless new evidence exists');
  const prior = previousAdaptations.at(-1);
  if (prior && prior.failedAction === failedAction && prior.nextStrategy === nextStrategy && newEvidenceIds.length === 0) {
    throw new Error('Repeated failed strategy requires new evidence or a changed strategy');
  }
  return {
    id: makeId('adapt'),
    failureCategory: category,
    failedAction,
    diagnosis: requireString(input?.diagnosis, 'diagnosis'),
    nextStrategy,
    newEvidenceIds,
    createdAt: now(),
  };
}
