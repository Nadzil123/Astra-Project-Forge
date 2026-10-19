import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { normalizeEvidenceRecord, evidenceQuery, reusableEvidence, upsertEvidence } from './evidence-records.mjs';
import { getStateIdentity, coordinateTransition, invalidateChangedCriteria, assessClaimSupport } from './coordination-core.mjs';
import { buildDecisionCapsule } from './decision-capsule.mjs';
import { resolveStateReferences } from './state-references.mjs';
import { withProjectLock, atomicWriteJSON, backupProjectFile } from './project-persistence.mjs';
import { normalizeEfficiencyPolicy, REASONING_LEVELS, nextReasoningLevel, policyBudget } from './efficiency-governor.mjs';
import { routeTask } from './adaptive-router.mjs';
import { selectDelta, compactContext, progressiveResult } from './context-efficiency.mjs';
import { normalizeEfficiencyLedger, applyEfficiencyEvent } from './efficiency-ledger.mjs';
import { makeEvidenceKey, invalidateByChangedDependency } from './evidence-cache.mjs';
import { prepareModelRoutingArgs, routeModelTransition } from './model-routing-state.mjs';
import { recordRevision, latestRecordRevision, stampChangedRecords } from './agent-state.mjs';
import { createGoalRecord, refreshBlockedGoals, updateGoalRecord, createClaimRecord, updateClaimRecord, createPlanRecord, createEvaluationRecord, createFailedStrategyRecord, createAdaptationRecord } from './agent-state.mjs';

const VERSION = 2;
const now = () => new Date().toISOString();

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}
function stringArray(value, name) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw new Error(`${name} must be an array of strings`);
  return value.map(v => v.trim()).filter(Boolean);
}
function validateConfidence(value) {
  if (value == null) return null;
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0 || value > 1) throw new Error('confidence must be a number between 0 and 1');
  return value;
}
function validateMode(value) {
  if (value == null) return 'standard';
  if (!['standard', 'deep'].includes(value)) throw new Error('mode must be "standard" or "deep"');
  return value;
}
function validateOutcome(value) {
  if (value == null) return 'inconclusive';
  const allowed = ['supported', 'falsified', 'inconclusive', 'mixed'];
  if (!allowed.includes(value)) throw new Error(`outcome must be one of: ${allowed.join(', ')}`);
  return value;
}
function safeFilename(projectId) {
  const clean = projectId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'project';
  const hash = createHash('sha256').update(projectId).digest('hex').slice(0, 12);
  return `${clean}-${hash}.json`;
}
const makeId = prefix => `${prefix}-${randomUUID()}`;

function normalizeUsage(value) {
  const usage = value && typeof value === 'object' ? value : {};
  return {
    ...usage,
    lastProfile: ['off', 'light', 'standard', 'deep'].includes(usage.lastProfile) ? usage.lastProfile : 'off',
    lastUsageImpact: ['MINIMAL', 'LOW', 'MODERATE', 'HIGH', 'VERY HIGH'].includes(usage.lastUsageImpact) ? usage.lastUsageImpact : 'MINIMAL',
    firstUseNoticeAcknowledged: usage.firstUseNoticeAcknowledged === true,
    deepWarningAcknowledged: usage.deepWarningAcknowledged === true,
  };
}

function normalizeEfficiency(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    ...source,
    policy: normalizeEfficiencyPolicy(source.policy),
    reasoningLevel: REASONING_LEVELS.includes(source.reasoningLevel) ? source.reasoningLevel : 'low',
    recentlyEscalated: source.recentlyEscalated === true,
    recentlyDeescalated: source.recentlyDeescalated === true,
    evidenceCache: Array.isArray(source.evidenceCache) ? source.evidenceCache : [],
    failedStrategies: Array.isArray(source.failedStrategies) ? source.failedStrategies : [],
    ledger: normalizeEfficiencyLedger(source.ledger),
  };
}

export function routeWithEfficiency(input, efficiency = {}) {
  const route = routeTask({
    completedCycles: efficiency.lastRoute?.completedCycles ?? 0,
    ...input, efficiencyPolicy: input.efficiencyPolicy ?? efficiency.policy,
  });
  const reasoningRecommendation = nextReasoningLevel({
    currentLevel: efficiency.reasoningLevel,
    recentlyEscalated: efficiency.recentlyEscalated,
    recentlyDeescalated: efficiency.recentlyDeescalated,
    ...input,
    highRisk: route.risk === 'high' || input.highRisk === true,
  });
  return { ...route, reasoningRecommendation };
}

function recordEvidenceReuse(project, record) {
  project.efficiency.ledger = applyEfficiencyEvent(project.efficiency.ledger, {
    type: 'reusedEvidence', amount: 1,
    provenance: { source: 'store', reference: `reuseEvidence:${record.key}` },
  });
}

function applyRouteWorkflow(project, input, query = actionCacheQuery(input)) {
  const route = routeWithEfficiency(input, project.efficiency);
  if (query && route.risk === 'high') query.risk = 'high';
  const independentValue = input.candidateHasIndependentValue === true && route.usefulReasons.length > 0;
  const evidenceRecord = query && !independentValue ? reusableEvidence(project, query) : null;
  if (evidenceRecord) {
    recordEvidenceReuse(project, evidenceRecord);
    if (!route.completionRecommended) route.efficiencyDecision = 'reuse';
    route.requiresJustification = false;
  }
  const current = input.currentLevel ?? project.efficiency.reasoningLevel;
  const direction = REASONING_LEVELS.indexOf(route.reasoningRecommendation.level) - REASONING_LEVELS.indexOf(current);
  project.efficiency.reasoningLevel = route.reasoningRecommendation.level;
  project.efficiency.recentlyEscalated = direction > 0 || (direction === 0
    && (input.recentlyEscalated ?? project.efficiency.recentlyEscalated)
    && input.uncertaintyResolved !== true && input.riskReducedMaterially !== true);
  project.efficiency.recentlyDeescalated = direction < 0 || (direction === 0
    && (input.recentlyDeescalated ?? project.efficiency.recentlyDeescalated));
  project.efficiency.lastRoute = { ...route, completedCycles: input.completedCycles ?? project.efficiency.lastRoute?.completedCycles ?? 0 };
  project.usage.lastProfile = route.profile;
  project.usage.lastUsageImpact = route.usageImpact;
  return {
    route,
    noticeRequired: project.usage.firstUseNoticeAcknowledged !== true,
    deepNoticeRequired: route.profile === 'deep' && project.usage.deepWarningAcknowledged !== true,
    ...(query ? { evidenceRecord } : {}),
  };
}

function actionCacheQuery(input) {
  if (!Object.hasOwn(input, 'cacheRequest')) return null;
  const query = evidenceQuery(input.cacheRequest);
  if (input.risk === 'high' || input.verificationRisk === 'high'
    || input.highRisk === true || input.reversible === false || input.expectedDecisionImpact === 'high') query.risk = 'high';
  return query;
}

export const BUDGET_OVERRIDE_CATEGORIES = [
  'unmet_success_criterion', 'important_uncertainty', 'high_risk_verification',
  'contradictory_evidence', 'blocked_goal', 'new_evidence_requires_replan',
];

function validateBudgetOverride(input) {
  if (!Object.hasOwn(input, 'budgetOverride')) return null;
  const override = input.budgetOverride;
  if (!override || typeof override !== 'object' || Array.isArray(override)
    || Object.keys(override).some(key => !['category', 'justification'].includes(key))) {
    throw new TypeError('budgetOverride requires only category and justification');
  }
  makeEvidenceKey({ params: override });
  if (!BUDGET_OVERRIDE_CATEGORIES.includes(override.category)) throw new TypeError('Invalid budgetOverride category');
  const justification = requireString(override.justification, 'budgetOverride justification');
  if (justification === override.category || justification === override.category.replaceAll('_', ' ')) {
    throw new TypeError('budgetOverride requires a concrete justification beyond its category');
  }
  return { category: override.category, justification };
}

function contextOptions(options) {
  const hasCursor = Object.hasOwn(options, 'sinceRevision');
  const progressive = Object.hasOwn(options, 'resultLevel');
  if (!hasCursor && !progressive) return null;
  if (hasCursor) recordRevision({ revision: options.sinceRevision });
  if (progressive && !['summary', 'relevant', 'full'].includes(options.resultLevel)) throw new TypeError('Invalid resultLevel');
  if (Object.hasOwn(options, 'detail') && !['summary', 'working', 'full', 'recovery'].includes(options.detail)) throw new TypeError('Invalid detail');
  const detail = options.detail ?? 'summary';
  const fullDetail = ['full', 'recovery'].includes(detail);
  const resultLevel = options.resultLevel ?? (fullDetail ? 'full' : detail === 'working' ? 'relevant' : 'summary');
  if (hasCursor && (fullDetail || resultLevel === 'full')) throw new TypeError('sinceRevision cannot be combined with full or recovery output');
  if (fullDetail && resultLevel !== 'full') throw new TypeError('Full and recovery detail require resultLevel full');
  return { detail, resultLevel, hasCursor };
}

function efficientContext(project, options, selection, maxItems) {
  const { detail, resultLevel, hasCursor } = selection;
  const metadata = { detail, resultLevel, revision: project.revision };
  if (hasCursor && options.sinceRevision > project.revision) throw new TypeError('sinceRevision exceeds the current project revision');
  if (resultLevel === 'full') return progressiveResult({ full: { ...metadata, project } }, resultLevel);
  const compact = compactContext(project);
  const projectSummary = {
    projectId: project.projectId, schemaVersion: project.schemaVersion,
    goal: project.goal, status: project.status,
    successCriteria: project.successCriteria, constraints: project.constraints,
  };
  let summary = { ...metadata, project: projectSummary, ...compact };
  if (hasCursor) {
    const groups = Object.fromEntries([
      'goalGraph', 'claims', 'observations', 'hypotheses', 'experiments', 'lessons',
      'plans', 'evaluations', 'adaptations', 'checkpoints', 'transferCandidates',
    ].map(key => [key, project[key]]));
    Object.assign(groups, {
      evidenceCache: project.efficiency.evidenceCache,
      failedStrategies: project.efficiency.failedStrategies,
      events: project.efficiency.ledger.events,
      consolidation: project.consolidation ? [project.consolidation] : [],
    });
    const changes = Object.fromEntries(Object.entries(groups).map(([key, records]) => [key,
      selectDelta(records.filter(record => record && typeof record === 'object' && !Array.isArray(record)), options.sinceRevision),
    ]));
    summary = {
      ...metadata, project: projectSummary, sinceRevision: options.sinceRevision,
      stableFacts: compact.stableFacts, activeGoals: compact.activeGoals,
      unresolvedClaims: compact.unresolvedClaims, verifiedLessons: compact.verifiedLessons,
      archiveRef: compact.archiveRef, changes,
    };
  }
  const { evidenceCache, failedStrategies, ledger, ...efficiencyState } = project.efficiency;
  const { events, ...counters } = ledger;
  const relevant = {
    ...summary, usage: project.usage,
    efficiency: {
      ...efficiencyState, ledger: { ...counters, ...(hasCursor ? {} : { events: events.slice(-maxItems) }) },
      ...(hasCursor ? {} : { evidenceCache: evidenceCache.slice(-maxItems), failedStrategies: failedStrategies.slice(-maxItems) }),
    },
  };
  return progressiveResult({ summary, relevant }, resultLevel);
}

function failedStrategyAttempts(project, strategyKey) {
  const matches = record => typeof record?.strategyKey === 'string' && record.strategyKey.trim() === strategyKey;
  const attempts = project.efficiency.failedStrategies.filter(record => record?.status === 'failed' && matches(record));
  // Older plan/evaluation pairs may predate persisted failure memory.
  const plans = new Map(project.plans.filter(matches).map(plan => [plan.id, plan]));
  for (const evaluation of project.evaluations) {
    const plan = plans.get(evaluation.planId);
    if (!plan || !['falsified', 'blocked'].includes(evaluation.outcome)) continue;
    attempts.push({
      ...plan,
      newEvidenceIds: [
        ...stringArray(plan.newEvidenceIds, 'newEvidenceIds'),
        ...stringArray(evaluation.evidenceIds, 'evidenceIds'),
      ],
    });
  }
  return attempts;
}

function makeRootGoal(project) {
  const timestamp = project.createdAt || now();
  return {
    id: 'goal-root',
    parentId: null,
    title: requireString(project.goal, 'goal'),
    description: requireString(project.goal, 'goal'),
    status: project.status === 'consolidated' ? 'verified' : project.status === 'blocked' ? 'blocked' : 'active',
    priority: 100,
    dependencies: [],
    successCriteria: Array.isArray(project.successCriteria) ? [...project.successCriteria] : [],
    evidenceIds: [],
    createdAt: timestamp,
    updatedAt: project.updatedAt || timestamp,
  };
}

function normalizeProject(project) {
  if (!project || typeof project !== 'object') throw new Error('Invalid project state');
  requireString(project.projectId, 'projectId');
  requireString(project.goal, 'goal');
  const normalized = {
    ...project,
    schemaVersion: VERSION,
    coordination: project.coordination ?? { epoch: getStateIdentity(project).epoch, operations: {}, criteria: [] },
    revision: recordRevision(project),
    efficiency: normalizeEfficiency(project.efficiency),
    successCriteria: Array.isArray(project.successCriteria) ? project.successCriteria : [],
    constraints: Array.isArray(project.constraints) ? project.constraints : [],
    observations: Array.isArray(project.observations) ? project.observations : [],
    hypotheses: Array.isArray(project.hypotheses) ? project.hypotheses : [],
    experiments: Array.isArray(project.experiments) ? project.experiments : [],
    checkpoints: Array.isArray(project.checkpoints) ? project.checkpoints : [],
    lessons: Array.isArray(project.lessons) ? project.lessons : [],
    goalGraph: Array.isArray(project.goalGraph) && project.goalGraph.length ? project.goalGraph : [makeRootGoal(project)],
    claims: Array.isArray(project.claims) ? project.claims : [],
    plans: Array.isArray(project.plans) ? project.plans : [],
    evaluations: Array.isArray(project.evaluations) ? project.evaluations : [],
    adaptations: Array.isArray(project.adaptations) ? project.adaptations : [],
    transferCandidates: Array.isArray(project.transferCandidates) ? project.transferCandidates : [],
    usage: normalizeUsage(project.usage),
    consolidation: project.consolidation ?? null,
    createdAt: project.createdAt || now(),
    updatedAt: project.updatedAt || project.createdAt || now(),
  };
  latestRecordRevision(normalized);
  return normalized;
}

export class ProjectStore {
  #baselines = new WeakMap();
  constructor(rootDir) {
    if (!rootDir) throw new Error('A data directory is required');
    this.rootDir = path.resolve(rootDir);
  }
  async #ensure() { await mkdir(this.rootDir, { recursive: true }); }
  #path(projectId) { return path.join(this.rootDir, safeFilename(requireString(projectId, 'projectId'))); }
  async #withProject(projectId, work) {
    return withProjectLock(this.#path(projectId), work);
  }
  async #write(project, previous = this.#baselines.get(project)) {
    invalidateChangedCriteria(project, previous);
    const revision = Math.max(latestRecordRevision(project), previous ? latestRecordRevision(previous) : 0) + 1;
    recordRevision({ revision });
    stampChangedRecords(project, previous, revision);
    project.revision = revision;
    await this.#ensure();
    project.updatedAt = now();
    const target = this.#path(project.projectId);
    if (previous && previous.schemaVersion !== VERSION) {
      // Preserve the exact legacy snapshot before its first schema migration.
      await backupProjectFile(target);
    }
    await atomicWriteJSON(target, project);
    this.#baselines.set(project, structuredClone(project));
    return project;
  }
  async getProject(projectId) {
    return this.#withProject(projectId, async () => {
      return this.#load(projectId, true);
    });
  }
  async #load(projectId, persistMigration) {
    await this.#ensure();
    try {
      const raw = JSON.parse(await readFile(this.#path(projectId), 'utf8'));
      const migrated = normalizeProject(raw);
      if (persistMigration && JSON.stringify(raw) !== JSON.stringify(migrated)) await this.#write(migrated, raw);
      else this.#baselines.set(migrated, structuredClone(raw));
      return migrated;
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`Project not found: ${projectId}`);
      throw error;
    }
  }
  async transact(projectId, update) {
    return this.#withProject(projectId, async () => {
      if (typeof update !== 'function' || update.constructor?.name === 'AsyncFunction') {
        throw new TypeError('Transaction update must be a synchronous function');
      }
      const project = await this.#load(projectId, false);
      const snapshot = structuredClone(project);
      const skipped = new WeakMap();
      const result = update(project, { noCommit(value) {
        const marker = Object.freeze(Object.create(null));
        skipped.set(marker, value);
        return marker;
      } });
      if (result && typeof result === 'object' && skipped.has(result)) {
        if (!isDeepStrictEqual(project, snapshot)) throw new TypeError('noCommit callback must not mutate project');
        return { project, result: skipped.get(result) };
      }
      if (project.projectId !== requireString(projectId, 'projectId')) {
        throw new TypeError('Transaction cannot change projectId identity');
      }
      if (result && typeof result.then === 'function') {
        // A rejected native Promise must not leak an unhandled rejection.
        if (result instanceof Promise) result.catch(() => {});
        throw new TypeError('Transaction update must be synchronous; async results are unsupported');
      }
      await this.#write(project);
      return { project, result };
    });
  }
  async initializeProject(input) {
    return this.#withProject(input?.projectId, async () => {
      const projectId = requireString(input?.projectId, 'projectId');
      const goal = requireString(input?.goal, 'goal');
      const timestamp = now();
      const project = {
        schemaVersion: VERSION, projectId, goal, coordination: { epoch: randomUUID(), operations: {}, criteria: [] }, mode: validateMode(input?.mode),
        successCriteria: stringArray(input?.successCriteria, 'successCriteria'),
        constraints: stringArray(input?.constraints, 'constraints'), status: 'active',
        createdAt: timestamp, updatedAt: timestamp, observations: [], hypotheses: [], experiments: [], checkpoints: [], lessons: [],
        goalGraph: [], claims: [], plans: [], evaluations: [], adaptations: [], transferCandidates: [], usage: normalizeUsage(null), consolidation: null
      };
      project.goalGraph = [makeRootGoal(project)];
      let previous;
      try {
        previous = JSON.parse(await readFile(this.#path(projectId), 'utf8'));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      return this.#write(normalizeProject(project), previous);
    });
  }
  async getGoals(projectId) {
    return this.#withProject(projectId, async () => {
      const project = await this.getProject(projectId);
      return project.goalGraph;
    });
  }
  async setEfficiencyPolicy(projectId, policy) {
    return this.#withProject(projectId, async () => {
      const project = await this.getProject(projectId);
      project.efficiency.policy = normalizeEfficiencyPolicy(policy);
      await this.#write(project);
      return project.efficiency;
    });
  }
  async routeProject(projectId, input) {
    return this.#withProject(projectId, async () => {
      const query = actionCacheQuery(input);
      const project = await this.getProject(projectId);
      const result = applyRouteWorkflow(project, input, query);
      await this.#write(project);
      return result;
    });
  }
  async routeProjectWithModelAdvice(projectId, args, runtime) {
    const input = prepareModelRoutingArgs(projectId, args);
    const descriptor = structuredClone(runtime);
    const { result } = await this.transact(projectId, (project, control) =>
      routeModelTransition(project, input, descriptor, control, applyRouteWorkflow));
    return result;
  }
  async setReasoningState(projectId, patch = {}) {
    return this.#withProject(projectId, async () => {
      makeEvidenceKey({ params: patch });
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)
        || Object.keys(patch).some(key => !['reasoningLevel', 'recentlyEscalated', 'recentlyDeescalated'].includes(key))) {
        throw new TypeError('Invalid reasoning state patch');
      }
      if (Object.hasOwn(patch, 'reasoningLevel') && !REASONING_LEVELS.includes(patch.reasoningLevel)) {
        throw new TypeError('Invalid reasoning level');
      }
      for (const field of ['recentlyEscalated', 'recentlyDeescalated']) {
        if (Object.hasOwn(patch, field) && typeof patch[field] !== 'boolean') throw new TypeError(`${field} must be boolean`);
      }
      const project = await this.getProject(projectId);
      // Persist guidance and hysteresis only, never a claim about host effort.
      Object.assign(project.efficiency, patch);
      await this.#write(project);
      return project.efficiency;
    });
  }
  async recordEfficiencyEvent(projectId, event) {
    return this.#withProject(projectId, async () => {
      applyEfficiencyEvent(null, event);
      if (event.provenance.source !== 'reported') throw new TypeError('External efficiency events must have reported provenance');
      if (Object.hasOwn(event, 'revision')) throw new TypeError('Event revisions are store-managed');
      const project = await this.getProject(projectId);
      project.efficiency.ledger = applyEfficiencyEvent(project.efficiency.ledger, event);
      await this.#write(project);
      return project.efficiency.ledger;
    });
  }
  async upsertEvidenceRecord(projectId, input) {
    return this.#withProject(projectId, async () => {
      const validated = normalizeEvidenceRecord(input);
      const project = await this.getProject(projectId);
      const record = upsertEvidence(project, validated);
      await this.#write(project);
      return record;
    });
  }
  async invalidateEvidence(projectId, changedIds) {
    return this.#withProject(projectId, async () => {
      invalidateByChangedDependency([], changedIds);
      const project = await this.getProject(projectId);
      project.efficiency.evidenceCache = invalidateByChangedDependency(project.efficiency.evidenceCache, changedIds);
      await this.#write(project);
      return project.efficiency.evidenceCache;
    });
  }
  async findReusableEvidence(projectId, input) {
    return this.#withProject(projectId, async () => {
      const query = evidenceQuery(input);
      return reusableEvidence(await this.getProject(projectId), query);
    });
  }
  async reuseEvidence(projectId, input) {
    return this.#withProject(projectId, async () => {
      const query = evidenceQuery(input);
      const project = await this.getProject(projectId);
      const record = reusableEvidence(project, query);
      if (!record) return null;
      recordEvidenceReuse(project, record);
      await this.#write(project);
      return record;
    });
  }
  async addGoal(projectId, input) {
    return this.#withProject(projectId, async () => {
      const project = await this.getProject(projectId);
      const record = createGoalRecord(input, project.goalGraph);
      project.goalGraph.push(record);
      refreshBlockedGoals(project.goalGraph);
      await this.#write(project);
      return record;
    });
  }
  async updateGoal(projectId, goalId, patch) {
    return this.#withProject(projectId, async () => {
      const project = await this.getProject(projectId);
      const goal = project.goalGraph.find(item => item.id === requireString(goalId, 'goalId'));
      if (!goal) throw new Error(`Goal not found: ${goalId}`);
      updateGoalRecord(goal, patch, project.goalGraph);
      refreshBlockedGoals(project.goalGraph);
      await this.#write(project);
      return goal;
    });
  }
  async addClaim(projectId, input) {
    return this.#withProject(projectId, async () => {
      const project = await this.getProject(projectId);
      const record = createClaimRecord(input);
      project.claims.push(record);
      assessClaimSupport(project, record, input);
      await this.#write(project);
      return record;
    });
  }
  async updateClaim(projectId, claimId, patch) {
    return this.#withProject(projectId, async () => {
      const project = await this.getProject(projectId);
      const claim = project.claims.find(item => item.id === requireString(claimId, 'claimId'));
      if (!claim) throw new Error(`Claim not found: ${claimId}`);
      updateClaimRecord(claim, patch);
      assessClaimSupport(project, claim, patch);
      await this.#write(project);
      return claim;
    });
  }
  async addPlan(projectId, input) {
    return this.#withProject(projectId, async () => {
      return (await this.planAction(projectId, input)).plan;
    });
  }
  async planAction(projectId, input) {
    return this.#withProject(projectId, async () => {
      const override = validateBudgetOverride(input);
      const record = createPlanRecord(input);
      const query = actionCacheQuery(input);
      const project = await this.getProject(projectId);
      if (input?.goalId != null) {
        const goal = project.goalGraph.find(item => item.id === input.goalId);
        if (!goal) throw new Error(`Goal not found: ${input.goalId}`);
        if (goal.status === 'blocked') throw new Error(`Goal is blocked: ${input.goalId}`);
        if (goal.status === 'verified' || goal.status === 'abandoned') throw new Error(`Goal is not actionable: ${input.goalId}`);
      }
      const evidenceRecord = query ? reusableEvidence(project, query) : null;
      if (evidenceRecord) {
        recordEvidenceReuse(project, evidenceRecord);
        await this.#write(project);
        return { plan: null, evidenceRecord, efficiencyDecision: 'reuse' };
      }
      if (record.strategyKey) {
        const attempts = failedStrategyAttempts(project, record.strategyKey);
        const usedEvidence = new Set(attempts.flatMap(attempt => stringArray(attempt.newEvidenceIds, 'newEvidenceIds')));
        const hasNewEvidence = record.newEvidenceIds.some(id => !usedEvidence.has(id));
        const hasChangedConditions = record.changedConditions !== null && !attempts.some(attempt =>
          typeof attempt.changedConditions === 'string' && attempt.changedConditions.trim() === record.changedConditions);
        if (attempts.length && !hasNewEvidence && !hasChangedConditions) {
          throw new Error(`Failed strategy cannot be repeated unchanged without new evidence or changed conditions: ${record.strategyKey}`);
        }
      }
      const policy = normalizeEfficiencyPolicy(input.efficiencyPolicy ?? project.efficiency.policy);
      const completedCycles = input.completedCycles ?? project.efficiency.lastRoute?.completedCycles ?? 0;
      const { softCycleBudget } = policyBudget(policy, project.efficiency.lastRoute?.profile ?? 'standard');
      const requiresOverride = ['MODERATE', 'HIGH', 'VERY HIGH'].includes(record.usageImpact) && completedCycles >= softCycleBudget;
      if (requiresOverride && !override) throw new Error('Soft budget reached: budgetOverride with a concrete justification is required before expensive planned work');
      if (override) {
        record.budgetOverride = {
          ...override, policy, completedCycles, softCycleBudget,
          provenance: { source: 'reported', reference: `plan:${record.id}` },
        };
      }
      if (requiresOverride) {
        project.efficiency.ledger = applyEfficiencyEvent(project.efficiency.ledger, {
          type: 'softBudgetOverrides', amount: 1,
          provenance: { source: 'store', reference: `plan:${record.id}:budgetOverride` },
        });
      }
      project.plans.push(record);
      await this.#write(project);
      return { plan: record, ...(query ? { evidenceRecord: null } : {}) };
    });
  }
  async coordinateEvaluation(projectId, input) {
    const { result } = await this.transact(projectId, (project, control) => coordinateTransition(project, input, control));
    return result;
  }
  async addEvaluation(projectId, input) {
    return this.#withProject(projectId, async () => {
      const project = await this.getProject(projectId);
      if (input?.goalId != null && !project.goalGraph.some(item => item.id === input.goalId)) throw new Error(`Goal not found: ${input.goalId}`);
      if (input?.planId != null && !project.plans.some(item => item.id === input.planId)) throw new Error(`Plan not found: ${input.planId}`);
      const record = createEvaluationRecord(input);
      project.evaluations.push(record);
      const plan = project.plans.find(item => item.id === record.planId);
      if (plan?.strategyKey && ['falsified', 'blocked'].includes(record.outcome)) {
        project.efficiency.failedStrategies.push(createFailedStrategyRecord(plan, record));
      }
      await this.#write(project);
      return record;
    });
  }
  async addAdaptation(projectId, input) {
    return this.#withProject(projectId, async () => {
      const project = await this.getProject(projectId);
      const record = createAdaptationRecord(input, project.adaptations);
      project.adaptations.push(record);
      await this.#write(project);
      return record;
    });
  }
  async addTransferCandidate(projectId, input) {
    return this.#withProject(projectId, async () => {
      const project = await this.getProject(projectId);
      const record = {
        id: makeId('transfer'),
        sourceProjectId: requireString(input?.sourceProjectId, 'sourceProjectId'),
        lesson: requireString(input?.lesson, 'lesson'),
        relevance: input?.relevance == null ? null : requireString(input.relevance, 'relevance'),
        status: 'candidate',
        validationEvidenceIds: [],
        createdAt: now(),
        updatedAt: now(),
      };
      project.transferCandidates.push(record);
      await this.#write(project);
      return record;
    });
  }
  async validateTransferCandidate(projectId, candidateId, evidenceIds) {
    return this.#withProject(projectId, async () => {
      const project = await this.getProject(projectId);
      const candidate = project.transferCandidates.find(item => item.id === requireString(candidateId, 'candidateId'));
      if (!candidate) throw new Error(`Transfer candidate not found: ${candidateId}`);
      const evidence = stringArray(evidenceIds, 'evidenceIds');
      if (!evidence.length) throw new Error('Local validation evidence is required before promoting a transfer candidate');
      candidate.status = 'validated';
      candidate.validationEvidenceIds = evidence;
      candidate.updatedAt = now();
      await this.#write(project);
      return candidate;
    });
  }
  async getRecoveryContext(projectId) {
    return this.#withProject(projectId, async () => {
      const project = await this.getProject(projectId);
      return {
        projectId: project.projectId,
        goal: project.goal,
        status: project.status,
        latestCheckpoint: project.checkpoints.at(-1) ?? null,
        openGoals: project.goalGraph.filter(item => !['verified', 'abandoned'].includes(item.status)),
        openClaims: project.claims.filter(item => ['unknown', 'inferred', 'contradicted'].includes(item.status)),
        lastPlan: project.plans.at(-1) ?? null,
        lastEvaluation: project.evaluations.at(-1) ?? null,
        lastAdaptation: project.adaptations.at(-1) ?? null,
        validatedTransfers: project.transferCandidates.filter(item => item.status === 'validated').slice(-5),
        updatedAt: project.updatedAt,
      };
    });
  }
  async setUsageState(projectId, patch = {}) {
    return this.#withProject(projectId, async () => {
      const project = await this.getProject(projectId);
      if (patch.lastProfile != null) {
        if (!['off', 'light', 'standard', 'deep'].includes(patch.lastProfile)) throw new Error('Invalid usage profile');
        project.usage.lastProfile = patch.lastProfile;
      }
      if (patch.lastUsageImpact != null) {
        if (!['MINIMAL', 'LOW', 'MODERATE', 'HIGH', 'VERY HIGH'].includes(patch.lastUsageImpact)) throw new Error('Invalid usage impact');
        project.usage.lastUsageImpact = patch.lastUsageImpact;
      }
      if (patch.firstUseNoticeAcknowledged != null) project.usage.firstUseNoticeAcknowledged = patch.firstUseNoticeAcknowledged === true;
      if (patch.deepWarningAcknowledged != null) project.usage.deepWarningAcknowledged = patch.deepWarningAcknowledged === true;
      await this.#write(project);
      return project.usage;
    });
  }
  async addObservation(projectId, input) {
    return this.#withProject(projectId, async () => {
      return (await this.recordObservation(projectId, input)).observation;
    });
  }
  async recordObservation(projectId, input) {
    return this.#withProject(projectId, async () => {
      const validated = Object.hasOwn(input, 'evidenceRecord') ? normalizeEvidenceRecord(input.evidenceRecord) : null;
      const record = { id: makeId('obs'), observation: requireString(input?.observation, 'observation'), evidence: input?.evidence == null ? null : requireString(input.evidence, 'evidence'), confidence: validateConfidence(input?.confidence), createdAt: now() };
      const project = await this.getProject(projectId);
      const evidenceRecord = validated ? upsertEvidence(project, { ...validated, observationId: record.id }) : null;
      project.observations.push(record);
      await this.#write(project);
      return { observation: record, ...(validated ? { evidenceRecord } : {}) };
    });
  }
  async addHypothesis(projectId, input) {
    return this.#withProject(projectId, async () => {
      const project = await this.getProject(projectId);
      const record = { id: makeId('hyp'), hypothesis: requireString(input?.hypothesis, 'hypothesis'), test: input?.test == null ? null : requireString(input.test, 'test'), confidence: validateConfidence(input?.confidence), status: 'open', createdAt: now() };
      project.hypotheses.push(record); await this.#write(project); return record;
    });
  }
  async addExperiment(projectId, input) {
    return this.#withProject(projectId, async () => {
      const project = await this.getProject(projectId);
      const record = { id: makeId('exp'), hypothesisId: input?.hypothesisId == null ? null : requireString(input.hypothesisId, 'hypothesisId'), action: requireString(input?.action, 'action'), result: requireString(input?.result, 'result'), outcome: validateOutcome(input?.outcome), lesson: input?.lesson == null ? null : requireString(input.lesson, 'lesson'), createdAt: now() };
      project.experiments.push(record);
      if (record.hypothesisId) {
        const hyp = project.hypotheses.find(h => h.id === record.hypothesisId);
        if (hyp) { hyp.status = record.outcome === 'supported' ? 'supported' : record.outcome === 'falsified' ? 'falsified' : 'open'; hyp.updatedAt = now(); }
      }
      if (record.lesson) project.lessons.push({ id: makeId('lesson'), text: record.lesson, sourceExperimentId: record.id, createdAt: now() });
      await this.#write(project); return record;
    });
  }
  async addCheckpoint(projectId, input) {
    return this.#withProject(projectId, async () => {
      const project = await this.getProject(projectId);
      const record = { id: makeId('checkpoint'), summary: requireString(input?.summary, 'summary'), decisions: stringArray(input?.decisions, 'decisions'), nextSteps: stringArray(input?.nextSteps, 'nextSteps'), remainingUnknowns: stringArray(input?.remainingUnknowns, 'remainingUnknowns'), createdAt: now() };
      project.checkpoints.push(record); await this.#write(project); return record;
    });
  }
  async consolidate(projectId, input) {
    return this.#withProject(projectId, async () => {
      const project = await this.getProject(projectId);
      const record = { verifiedResult: requireString(input?.verifiedResult, 'verifiedResult'), evidence: stringArray(input?.evidence, 'evidence'), lessons: stringArray(input?.lessons, 'lessons'), remainingUncertainty: stringArray(input?.remainingUncertainty, 'remainingUncertainty'), createdAt: now() };
      for (const lesson of record.lessons) project.lessons.push({ id: makeId('lesson'), text: lesson, sourceExperimentId: null, createdAt: now() });
      project.consolidation = record; project.status = 'consolidated'; await this.#write(project); return record;
    });
  }
  async getDecisionCapsule(projectId, options = {}) {
    return this.#withProject(projectId, async () => buildDecisionCapsule(await this.#load(projectId, false), options));
  }
  async getReferences(projectId, references) {
    return this.#withProject(projectId, async () => resolveStateReferences(await this.#load(projectId, false), references));
  }
  async getContext(projectId, options = {}) {
    return this.#withProject(projectId, async () => {
      const selection = contextOptions(options ?? {});
      const project = await this.getProject(projectId);
      const detail = ['summary', 'working', 'full'].includes(options?.detail) ? options.detail : 'summary';
      const requested = Number.isInteger(options?.maxItems) ? options.maxItems : 5;
      const maxItems = Math.min(20, Math.max(1, requested));

      if (selection) return efficientContext(project, options, selection, maxItems);

      if (detail === 'full') return { project };

      const projectSummary = {
        schemaVersion: project.schemaVersion, projectId: project.projectId, goal: project.goal, mode: project.mode,
        successCriteria: project.successCriteria, constraints: project.constraints, status: project.status,
        createdAt: project.createdAt, updatedAt: project.updatedAt,
      };
      const counts = {
        goals: project.goalGraph.length, claims: project.claims.length,
        observations: project.observations.length, hypotheses: project.hypotheses.length,
        experiments: project.experiments.length, plans: project.plans.length,
        evaluations: project.evaluations.length, adaptations: project.adaptations.length,
        checkpoints: project.checkpoints.length, lessons: project.lessons.length,
        transferCandidates: project.transferCandidates.length,
      };
      const latestCheckpoint = project.checkpoints.at(-1) ?? null;
      const recentLessons = project.lessons.slice(-maxItems);
      const base = {
        detail, project: projectSummary, counts, latestCheckpoint, recentLessons,
        usage: project.usage, consolidation: project.consolidation,
      };

      if (detail === 'summary') return base;

      const openHypotheses = project.hypotheses.filter(item => item.status === 'open');
      const openGoals = project.goalGraph.filter(item => !['verified', 'abandoned'].includes(item.status));
      const openClaims = project.claims.filter(item => ['unknown', 'inferred', 'contradicted'].includes(item.status));
      return {
        ...base,
        goals: (openGoals.length ? openGoals : project.goalGraph).slice(-maxItems),
        claims: (openClaims.length ? openClaims : project.claims).slice(-maxItems),
        observations: project.observations.slice(-maxItems),
        hypotheses: (openHypotheses.length ? openHypotheses : project.hypotheses).slice(-maxItems),
        experiments: project.experiments.slice(-maxItems),
        plans: project.plans.slice(-maxItems),
        evaluations: project.evaluations.slice(-maxItems),
        adaptations: project.adaptations.slice(-maxItems),
        transferCandidates: project.transferCandidates.slice(-maxItems),
        checkpoints: project.checkpoints.slice(-maxItems),
      };
    });
  }
  async listProjects() {
    await this.#ensure();
    const names = (await readdir(this.rootDir)).filter(name => name.endsWith('.json'));
    const projects = [];
    for (const name of names) {
      try {
        const p = JSON.parse(await readFile(path.join(this.rootDir, name), 'utf8'));
        projects.push({ projectId: p.projectId, goal: p.goal, mode: p.mode, status: p.status, updatedAt: p.updatedAt });
      } catch {}
    }
    return projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
}
