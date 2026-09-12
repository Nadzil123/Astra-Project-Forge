import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createGoalRecord, refreshBlockedGoals, updateGoalRecord, createClaimRecord, updateClaimRecord, createPlanRecord, createEvaluationRecord, createAdaptationRecord } from './agent-state.mjs';

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
    lastProfile: ['off', 'light', 'standard', 'deep'].includes(usage.lastProfile) ? usage.lastProfile : 'off',
    lastUsageImpact: ['MINIMAL', 'LOW', 'MODERATE', 'HIGH', 'VERY HIGH'].includes(usage.lastUsageImpact) ? usage.lastUsageImpact : 'MINIMAL',
    firstUseNoticeAcknowledged: usage.firstUseNoticeAcknowledged === true,
    deepWarningAcknowledged: usage.deepWarningAcknowledged === true,
  };
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
  return normalized;
}

export class ProjectStore {
  constructor(rootDir) {
    if (!rootDir) throw new Error('A data directory is required');
    this.rootDir = path.resolve(rootDir);
  }
  async #ensure() { await mkdir(this.rootDir, { recursive: true }); }
  #path(projectId) { return path.join(this.rootDir, safeFilename(requireString(projectId, 'projectId'))); }
  async #write(project) {
    await this.#ensure();
    project.updatedAt = now();
    const target = this.#path(project.projectId);
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(project, null, 2)}\n`, 'utf8');
    await rename(temp, target);
    return project;
  }
  async getProject(projectId) {
    await this.#ensure();
    try {
      const raw = JSON.parse(await readFile(this.#path(projectId), 'utf8'));
      const migrated = normalizeProject(raw);
      if (raw.schemaVersion !== VERSION || !Array.isArray(raw.goalGraph) || !raw.usage) await this.#write(migrated);
      return migrated;
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`Project not found: ${projectId}`);
      throw error;
    }
  }
  async initializeProject(input) {
    const projectId = requireString(input?.projectId, 'projectId');
    const goal = requireString(input?.goal, 'goal');
    const timestamp = now();
    const project = {
      schemaVersion: VERSION, projectId, goal, mode: validateMode(input?.mode),
      successCriteria: stringArray(input?.successCriteria, 'successCriteria'),
      constraints: stringArray(input?.constraints, 'constraints'), status: 'active',
      createdAt: timestamp, updatedAt: timestamp, observations: [], hypotheses: [], experiments: [], checkpoints: [], lessons: [],
      goalGraph: [], claims: [], plans: [], evaluations: [], adaptations: [], transferCandidates: [], usage: normalizeUsage(null), consolidation: null
    };
    project.goalGraph = [makeRootGoal(project)];
    return this.#write(project);
  }
  async getGoals(projectId) {
    const project = await this.getProject(projectId);
    return project.goalGraph;
  }
  async addGoal(projectId, input) {
    const project = await this.getProject(projectId);
    const record = createGoalRecord(input, project.goalGraph);
    project.goalGraph.push(record);
    refreshBlockedGoals(project.goalGraph);
    await this.#write(project);
    return record;
  }
  async updateGoal(projectId, goalId, patch) {
    const project = await this.getProject(projectId);
    const goal = project.goalGraph.find(item => item.id === requireString(goalId, 'goalId'));
    if (!goal) throw new Error(`Goal not found: ${goalId}`);
    updateGoalRecord(goal, patch, project.goalGraph);
    refreshBlockedGoals(project.goalGraph);
    await this.#write(project);
    return goal;
  }
  async addClaim(projectId, input) {
    const project = await this.getProject(projectId);
    const record = createClaimRecord(input);
    project.claims.push(record);
    await this.#write(project);
    return record;
  }
  async updateClaim(projectId, claimId, patch) {
    const project = await this.getProject(projectId);
    const claim = project.claims.find(item => item.id === requireString(claimId, 'claimId'));
    if (!claim) throw new Error(`Claim not found: ${claimId}`);
    updateClaimRecord(claim, patch);
    await this.#write(project);
    return claim;
  }
  async addPlan(projectId, input) {
    const project = await this.getProject(projectId);
    if (input?.goalId != null) {
      const goal = project.goalGraph.find(item => item.id === input.goalId);
      if (!goal) throw new Error(`Goal not found: ${input.goalId}`);
      if (goal.status === 'blocked') throw new Error(`Goal is blocked: ${input.goalId}`);
      if (goal.status === 'verified' || goal.status === 'abandoned') throw new Error(`Goal is not actionable: ${input.goalId}`);
    }
    const record = createPlanRecord(input);
    project.plans.push(record);
    await this.#write(project);
    return record;
  }
  async addEvaluation(projectId, input) {
    const project = await this.getProject(projectId);
    if (input?.goalId != null && !project.goalGraph.some(item => item.id === input.goalId)) throw new Error(`Goal not found: ${input.goalId}`);
    if (input?.planId != null && !project.plans.some(item => item.id === input.planId)) throw new Error(`Plan not found: ${input.planId}`);
    const record = createEvaluationRecord(input);
    project.evaluations.push(record);
    await this.#write(project);
    return record;
  }
  async addAdaptation(projectId, input) {
    const project = await this.getProject(projectId);
    const record = createAdaptationRecord(input, project.adaptations);
    project.adaptations.push(record);
    await this.#write(project);
    return record;
  }
  async addTransferCandidate(projectId, input) {
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
  }
  async validateTransferCandidate(projectId, candidateId, evidenceIds) {
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
  }
  async getRecoveryContext(projectId) {
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
  }
  async setUsageState(projectId, patch = {}) {
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
  }
  async addObservation(projectId, input) {
    const project = await this.getProject(projectId);
    const record = { id: makeId('obs'), observation: requireString(input?.observation, 'observation'), evidence: input?.evidence == null ? null : requireString(input.evidence, 'evidence'), confidence: validateConfidence(input?.confidence), createdAt: now() };
    project.observations.push(record); await this.#write(project); return record;
  }
  async addHypothesis(projectId, input) {
    const project = await this.getProject(projectId);
    const record = { id: makeId('hyp'), hypothesis: requireString(input?.hypothesis, 'hypothesis'), test: input?.test == null ? null : requireString(input.test, 'test'), confidence: validateConfidence(input?.confidence), status: 'open', createdAt: now() };
    project.hypotheses.push(record); await this.#write(project); return record;
  }
  async addExperiment(projectId, input) {
    const project = await this.getProject(projectId);
    const record = { id: makeId('exp'), hypothesisId: input?.hypothesisId == null ? null : requireString(input.hypothesisId, 'hypothesisId'), action: requireString(input?.action, 'action'), result: requireString(input?.result, 'result'), outcome: validateOutcome(input?.outcome), lesson: input?.lesson == null ? null : requireString(input.lesson, 'lesson'), createdAt: now() };
    project.experiments.push(record);
    if (record.hypothesisId) {
      const hyp = project.hypotheses.find(h => h.id === record.hypothesisId);
      if (hyp) { hyp.status = record.outcome === 'supported' ? 'supported' : record.outcome === 'falsified' ? 'falsified' : 'open'; hyp.updatedAt = now(); }
    }
    if (record.lesson) project.lessons.push({ id: makeId('lesson'), text: record.lesson, sourceExperimentId: record.id, createdAt: now() });
    await this.#write(project); return record;
  }
  async addCheckpoint(projectId, input) {
    const project = await this.getProject(projectId);
    const record = { id: makeId('checkpoint'), summary: requireString(input?.summary, 'summary'), decisions: stringArray(input?.decisions, 'decisions'), nextSteps: stringArray(input?.nextSteps, 'nextSteps'), remainingUnknowns: stringArray(input?.remainingUnknowns, 'remainingUnknowns'), createdAt: now() };
    project.checkpoints.push(record); await this.#write(project); return record;
  }
  async consolidate(projectId, input) {
    const project = await this.getProject(projectId);
    const record = { verifiedResult: requireString(input?.verifiedResult, 'verifiedResult'), evidence: stringArray(input?.evidence, 'evidence'), lessons: stringArray(input?.lessons, 'lessons'), remainingUncertainty: stringArray(input?.remainingUncertainty, 'remainingUncertainty'), createdAt: now() };
    for (const lesson of record.lessons) project.lessons.push({ id: makeId('lesson'), text: lesson, sourceExperimentId: null, createdAt: now() });
    project.consolidation = record; project.status = 'consolidated'; await this.#write(project); return record;
  }
  async getContext(projectId, options = {}) {
    const project = await this.getProject(projectId);
    const detail = ['summary', 'working', 'full'].includes(options?.detail) ? options.detail : 'summary';
    const requested = Number.isInteger(options?.maxItems) ? options.maxItems : 5;
    const maxItems = Math.min(20, Math.max(1, requested));

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
