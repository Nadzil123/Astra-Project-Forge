#!/usr/bin/env node
import readline from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectStore } from './state-store.mjs';
import { routeTask } from './adaptive-router.mjs';

const SERVER_NAME = 'astra-project-forge';
const SERVER_VERSION = '2.6.0';
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const dataDir = process.env.ASTRA_PROJECT_FORGE_DATA_DIR || process.env.PLUGIN_DATA || path.join(os.homedir(), '.astra-project-forge');
const store = new ProjectStore(dataDir);

const objectSchema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = description => ({ type: 'string', description });
const strings = description => ({ type: 'array', items: { type: 'string' }, description });
const confidence = { type: 'number', minimum: 0, maximum: 1, description: 'Confidence from 0.0 to 1.0.' };
const bool = description => ({ type: 'boolean', description });
const integer = (description, minimum, maximum) => ({ type: 'integer', minimum, maximum, description });

const legacyTools = [
  {
    name: 'adaptive_route_task', title: 'Route task to an adaptive budget',
    description: 'Use this when deciding whether Astra Project Forge should stay off or use a light, standard, or deep workflow. The returned cycle budget is a workflow limit, not a measurement or guarantee of model tokens.',
    inputSchema: objectSchema({
      taskSummary: str('Short semantic summary of the task.'),
      complexity: { type: 'string', enum: ['simple', 'moderate', 'complex'], description: 'Overall task complexity.' },
      uncertainty: { type: 'string', enum: ['low', 'medium', 'high'], description: 'How much important uncertainty remains.' },
      continuityNeeded: bool('Whether useful state must survive later turns or sessions.'),
      repeatedFailure: bool('Whether meaningful attempts have already failed or looped.'),
      crossDomain: bool('Whether the task spans multiple domains or subsystems.'),
      verificationNeeded: bool('Whether objective verification is important.'),
      multiStep: bool('Whether multiple dependent steps are required.'),
      capabilityNeeds: strings('Capability categories likely useful, such as repository, docs, testing, review, security, runtime, CI, research, data, design, or writing.')
    }, ['complexity']),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'adaptive_get_context', title: 'Read selective adaptive project context',
    description: 'Use this instead of loading full project history by default. Summary returns compact metadata and counts; working returns recent decision-relevant records; full returns the complete project only when genuinely needed.',
    inputSchema: objectSchema({
      projectId: str('Project identifier.'),
      detail: { type: 'string', enum: ['summary', 'working', 'full'], description: 'How much project state to return.' },
      maxItems: integer('Maximum recent records per working-state section.', 1, 20)
    }, ['projectId']),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'adaptive_initialize_project', title: 'Initialize adaptive project',
    description: 'Use this when starting or intentionally resetting a complex project learning state. It records the goal, success criteria, constraints, and adaptive mode.',
    inputSchema: objectSchema({
      projectId: str('Stable project identifier.'), goal: str('Concrete project goal.'),
      mode: { type: 'string', enum: ['standard', 'deep'], description: 'Use deep for novel, long-horizon, or repeatedly failing work.' },
      successCriteria: strings('Objective completion checks.'), constraints: strings('Constraints and non-goals that must be preserved.')
    }, ['projectId', 'goal']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'adaptive_get_state', title: 'Read adaptive project state',
    description: 'Use this before resuming a complex project or when the current evidence, hypotheses, experiments, lessons, or checkpoint history is needed.',
    inputSchema: objectSchema({ projectId: str('Project identifier.') }, ['projectId']),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'adaptive_list_projects', title: 'List adaptive projects',
    description: 'Use this when the available adaptive project states need to be discovered.',
    inputSchema: objectSchema({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'adaptive_record_observation', title: 'Record evidence-backed observation',
    description: 'Use this after inspecting code, documentation, logs, tests, tool output, or other evidence and a fact should become part of the working project model.',
    inputSchema: objectSchema({ projectId: str('Project identifier.'), observation: str('Concise observation supported by evidence.'), evidence: str('Optional source, command, test, file, or artifact supporting the observation.'), confidence }, ['projectId', 'observation']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'adaptive_record_hypothesis', title: 'Record testable hypothesis',
    description: 'Use this when a plausible explanation or implementation direction should be made explicit and tested instead of assumed.',
    inputSchema: objectSchema({ projectId: str('Project identifier.'), hypothesis: str('Testable explanation or implementation hypothesis.'), test: str('Optional smallest discriminating test or experiment.'), confidence }, ['projectId', 'hypothesis']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'adaptive_record_experiment', title: 'Record experiment result',
    description: 'Use this after a test, implementation attempt, benchmark, or experiment so the next strategy can change based on the result rather than repeat blindly.',
    inputSchema: objectSchema({
      projectId: str('Project identifier.'), hypothesisId: str('Optional hypothesis ID being tested.'), action: str('What was tried or tested.'), result: str('What objectively happened.'),
      outcome: { type: 'string', enum: ['supported', 'falsified', 'inconclusive', 'mixed'], description: 'Relationship between result and hypothesis.' }, lesson: str('Optional reusable project-specific lesson supported by this result.')
    }, ['projectId', 'action', 'result']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'adaptive_checkpoint', title: 'Create project checkpoint',
    description: 'Use this at a meaningful milestone, before a context switch, or after requirements change so later work can resume without rediscovering the same project state.',
    inputSchema: objectSchema({ projectId: str('Project identifier.'), summary: str('Current verified state of the project.'), decisions: strings('Important decisions or invariants established.'), nextSteps: strings('Highest-value next steps.'), remainingUnknowns: strings('Unknowns that could still change the solution.') }, ['projectId', 'summary']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'adaptive_consolidate', title: 'Consolidate verified learning',
    description: 'Use this only when a milestone or task has been verified. It consolidates the result, evidence, reusable lessons, and remaining uncertainty for future sessions.',
    inputSchema: objectSchema({ projectId: str('Project identifier.'), verifiedResult: str('What was actually verified.'), evidence: strings('Tests, commands, measurements, or other objective evidence.'), lessons: strings('Reusable lessons supported by the work.'), remainingUncertainty: strings('Known uncertainty that remains.') }, ['projectId', 'verifiedResult']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }
];

const forgeTools = [
  {
    name: 'forge_route', title: 'Route work through Astra Project Forge',
    description: 'Choose the smallest useful Forge workflow profile and estimate qualitative usage impact. This does not estimate exact token counts or billing.',
    inputSchema: objectSchema({
      projectId: str('Optional project identifier. When supplied, the selected profile and usage impact are persisted.'),
      taskSummary: str('Short semantic summary of the task.'),
      complexity: { type: 'string', enum: ['simple', 'moderate', 'complex'] },
      uncertainty: { type: 'string', enum: ['low', 'medium', 'high'] },
      continuityNeeded: bool('Whether useful state must survive later turns or sessions.'),
      repeatedFailure: bool('Whether meaningful attempts have already failed.'),
      crossDomain: bool('Whether the task spans multiple domains or subsystems.'),
      verificationNeeded: bool('Whether objective verification is important.'),
      multiStep: bool('Whether multiple dependent steps are required.'),
      capabilityNeeds: strings('Available capability categories likely to be useful.'),
      risk: { type: 'string', enum: ['low', 'medium', 'high'] },
      expectedIterations: integer('Expected number of adaptive iterations.', 0, 100)
    }, ['complexity']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'forge_goal', title: 'Manage Forge goal graph',
    description: 'Create, update, or list goal-graph nodes with dependencies and evidence-backed verification.',
    inputSchema: objectSchema({
      projectId: str('Project identifier.'), operation: { type: 'string', enum: ['list', 'create', 'update'] },
      goalId: str('Goal identifier for update.'), parentId: str('Parent goal identifier for create.'),
      title: str('Goal title.'), description: str('Goal description.'),
      status: { type: 'string', enum: ['pending', 'active', 'blocked', 'verified', 'abandoned'] },
      priority: integer('Priority from 0 to 100.', 0, 100), dependencies: strings('Goal IDs that must be verified first.'),
      successCriteria: strings('Goal-specific objective completion checks.'), evidenceIds: strings('Evidence IDs required for verification.')
    }, ['projectId', 'operation']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'forge_context', title: 'Read decision-relevant Forge context',
    description: 'Read summary, working, full, or recovery context. Prefer the smallest context that supports the next decision.',
    inputSchema: objectSchema({
      projectId: str('Project identifier.'),
      detail: { type: 'string', enum: ['summary', 'working', 'full', 'recovery'] },
      maxItems: integer('Maximum recent records per working-state section.', 1, 20)
    }, ['projectId']),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'forge_observe', title: 'Record evidence, claims, or transfer candidates',
    description: 'Record evidence-backed observations, epistemic claims, claim updates, or cross-project transfer candidates without treating unverified transfer as fact.',
    inputSchema: objectSchema({
      projectId: str('Project identifier.'),
      operation: { type: 'string', enum: ['observation', 'claim', 'update_claim', 'transfer_candidate', 'validate_transfer'] },
      observation: str('Evidence-backed observation.'), evidence: str('Evidence source.'), confidence,
      claimId: str('Claim identifier for update.'), statement: str('Claim statement.'),
      claimStatus: { type: 'string', enum: ['known', 'inferred', 'unknown', 'contradicted'] },
      evidenceIds: strings('Evidence identifiers.'), counterEvidenceIds: strings('Counter-evidence identifiers.'),
      scope: { type: 'string', enum: ['project', 'goal', 'task'] }, scopeId: str('Optional scope identifier.'),
      sourceProjectId: str('Source project for a transfer candidate.'), lesson: str('Candidate reusable lesson.'), relevance: str('Why the lesson may be relevant.'),
      candidateId: str('Transfer-candidate identifier for validation.')
    }, ['projectId', 'operation']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'forge_plan', title: 'Record a Forge next-action plan',
    description: 'Record a concise next action for an actionable goal without storing hidden chain-of-thought.',
    inputSchema: objectSchema({
      projectId: str('Project identifier.'), goalId: str('Target goal identifier.'), action: str('Next action.'), why: str('Concise decision rationale.'),
      expectedEvidence: str('Evidence expected from the action.'), risk: { type: 'string', enum: ['low', 'medium', 'high'] },
      reversible: bool('Whether the action is reversible.'), usageImpact: { type: 'string', enum: ['MINIMAL', 'LOW', 'MODERATE', 'HIGH', 'VERY HIGH'] }
    }, ['projectId', 'action', 'why']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'forge_evaluate', title: 'Evaluate a Forge result',
    description: 'Evaluate progress against explicit criteria and evidence, preserving missing criteria and blockers.',
    inputSchema: objectSchema({
      projectId: str('Project identifier.'), goalId: str('Goal identifier.'), planId: str('Plan identifier.'),
      outcome: { type: 'string', enum: ['verified', 'partially_verified', 'inconclusive', 'falsified', 'blocked'] },
      summary: str('Evaluation summary.'), evidenceIds: strings('Supporting evidence identifiers.'), missingCriteria: strings('Criteria not yet satisfied.')
    }, ['projectId', 'outcome', 'summary']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'forge_adapt', title: 'Adapt Forge strategy or acknowledge usage notices',
    description: 'Record a failure diagnosis and changed strategy, or persist acknowledgement of first-use/deep-mode usage notices.',
    inputSchema: objectSchema({
      projectId: str('Project identifier.'), operation: { type: 'string', enum: ['failure', 'acknowledge_usage'] },
      failureCategory: { type: 'string', enum: ['wrong_hypothesis','missing_information','implementation_defect','evaluation_defect','environment_tooling_issue','misunderstood_requirement','permission_limitation','performance_resource_limitation','conflicting_evidence','external_dependency'] },
      failedAction: str('Action that failed.'), diagnosis: str('Evidence-based failure diagnosis.'), nextStrategy: str('Materially changed next strategy.'),
      newEvidenceIds: strings('New evidence that justifies retrying a similar strategy.'),
      firstUseNoticeAcknowledged: bool('Whether the general usage notice has been acknowledged.'), deepWarningAcknowledged: bool('Whether the deep-mode notice has been acknowledged.')
    }, ['projectId', 'operation']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'forge_checkpoint', title: 'Create a Forge recovery checkpoint',
    description: 'Save a resumable milestone for long-running work.',
    inputSchema: objectSchema({
      projectId: str('Project identifier.'), summary: str('Current verified project state.'),
      decisions: strings('Important decisions.'), nextSteps: strings('Highest-value next steps.'), remainingUnknowns: strings('Decision-relevant unknowns.')
    }, ['projectId', 'summary']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'forge_consolidate', title: 'Consolidate verified Forge learning',
    description: 'Consolidate a verified milestone, evidence, lessons, and remaining uncertainty.',
    inputSchema: objectSchema({
      projectId: str('Project identifier.'), verifiedResult: str('Verified result.'),
      evidence: strings('Objective evidence.'), lessons: strings('Reusable verified lessons.'), remainingUncertainty: strings('Known remaining uncertainty.')
    }, ['projectId', 'verifiedResult']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }
];

export const tools = [...forgeTools, ...legacyTools];

function textResult(message, structuredContent) {
  const result = { content: [{ type: 'text', text: message }] };
  if (structuredContent !== undefined) result.structuredContent = structuredContent;
  return result;
}
const errorResult = message => ({ content: [{ type: 'text', text: message }], isError: true });

async function callTool(name, args = {}) {
  switch (name) {
    case 'forge_route': {
      const route = routeTask(args);
      let noticeRequired = false;
      let deepNoticeRequired = false;
      if (args.projectId) {
        const project = await store.getProject(args.projectId);
        noticeRequired = project.usage.firstUseNoticeAcknowledged !== true;
        deepNoticeRequired = route.profile === 'deep' && project.usage.deepWarningAcknowledged !== true;
        await store.setUsageState(args.projectId, { lastProfile: route.profile, lastUsageImpact: route.usageImpact });
      }
      const noticeText = noticeRequired || deepNoticeRequired ? ' Usage notice acknowledgement is required before proceeding with the indicated Forge intensity.' : '';
      return textResult(`Forge routing profile: ${route.profile}. Usage impact: ${route.usageImpact}.${noticeText}`, { route, noticeRequired, deepNoticeRequired });
    }
    case 'forge_goal': {
      if (args.operation === 'list') return textResult('Loaded Forge goal graph.', { goals: await store.getGoals(args.projectId) });
      if (args.operation === 'create') {
        const goal = await store.addGoal(args.projectId, args);
        return textResult(`Forge goal created: ${goal.title}.`, { goal });
      }
      if (args.operation === 'update') {
        const goal = await store.updateGoal(args.projectId, args.goalId, args);
        return textResult(`Forge goal updated: ${goal.title}.`, { goal });
      }
      return errorResult(`Unknown forge_goal operation: ${args.operation}`);
    }
    case 'forge_context': {
      if (args.detail === 'recovery') {
        const recovery = await store.getRecoveryContext(args.projectId);
        return textResult(`Loaded recovery context for "${args.projectId}".`, { recovery });
      }
      const context = await store.getContext(args.projectId, args);
      return textResult(`Loaded ${context.detail || 'full'} Forge context for "${args.projectId}".`, { context });
    }
    case 'forge_observe': {
      if (args.operation === 'observation') {
        const observation = await store.addObservation(args.projectId, args);
        return textResult('Forge observation recorded.', { observation });
      }
      if (args.operation === 'claim') {
        const claim = await store.addClaim(args.projectId, { ...args, status: args.claimStatus });
        return textResult('Forge epistemic claim recorded.', { claim });
      }
      if (args.operation === 'update_claim') {
        const claim = await store.updateClaim(args.projectId, args.claimId, { ...args, status: args.claimStatus });
        return textResult('Forge epistemic claim updated.', { claim });
      }
      if (args.operation === 'transfer_candidate') {
        const transferCandidate = await store.addTransferCandidate(args.projectId, args);
        return textResult('Forge transfer candidate recorded as unverified.', { transferCandidate });
      }
      if (args.operation === 'validate_transfer') {
        const transferCandidate = await store.validateTransferCandidate(args.projectId, args.candidateId, args.evidenceIds);
        return textResult('Forge transfer candidate validated for this project.', { transferCandidate });
      }
      return errorResult(`Unknown forge_observe operation: ${args.operation}`);
    }
    case 'forge_plan': {
      const plan = await store.addPlan(args.projectId, args);
      return textResult('Forge next-action plan recorded.', { plan });
    }
    case 'forge_evaluate': {
      const evaluation = await store.addEvaluation(args.projectId, args);
      return textResult(`Forge evaluation recorded: ${evaluation.outcome}.`, { evaluation });
    }
    case 'forge_adapt': {
      if (args.operation === 'failure') {
        const adaptation = await store.addAdaptation(args.projectId, args);
        return textResult('Forge adaptation recorded.', { adaptation });
      }
      if (args.operation === 'acknowledge_usage') {
        const usage = await store.setUsageState(args.projectId, {
          firstUseNoticeAcknowledged: args.firstUseNoticeAcknowledged,
          deepWarningAcknowledged: args.deepWarningAcknowledged,
        });
        return textResult('Forge usage notice state updated.', { usage });
      }
      return errorResult(`Unknown forge_adapt operation: ${args.operation}`);
    }
    case 'forge_checkpoint': {
      const checkpoint = await store.addCheckpoint(args.projectId, args);
      return textResult('Forge checkpoint saved.', { checkpoint });
    }
    case 'forge_consolidate': {
      const consolidation = await store.consolidate(args.projectId, args);
      return textResult('Verified Forge learning consolidated.', { consolidation });
    }
    case 'adaptive_route_task': {
      const route = routeTask(args);
      return textResult(`Astra routing profile: ${route.profile}. Workflow cycle budget: ${route.cycleBudget}.`, { route });
    }
    case 'adaptive_get_context': {
      const context = await store.getContext(args.projectId, args);
      return textResult(`Loaded ${context.detail || 'full'} adaptive context for "${args.projectId}".`, { context });
    }
    case 'adaptive_initialize_project': {
      const project = await store.initializeProject(args);
      return textResult(`Adaptive project "${project.projectId}" initialized in ${project.mode} mode.`, { project });
    }
    case 'adaptive_get_state': {
      const project = await store.getProject(args.projectId);
      return textResult(`Loaded adaptive state for "${project.projectId}".`, { project });
    }
    case 'adaptive_list_projects': {
      const projects = await store.listProjects();
      return textResult(`Found ${projects.length} adaptive project state(s).`, { projects });
    }
    case 'adaptive_record_observation': {
      const observation = await store.addObservation(args.projectId, args); return textResult('Observation recorded.', { observation });
    }
    case 'adaptive_record_hypothesis': {
      const hypothesis = await store.addHypothesis(args.projectId, args); return textResult('Hypothesis recorded. Test it before treating it as fact.', { hypothesis });
    }
    case 'adaptive_record_experiment': {
      const experiment = await store.addExperiment(args.projectId, args); return textResult(`Experiment recorded with outcome: ${experiment.outcome}.`, { experiment });
    }
    case 'adaptive_checkpoint': {
      const checkpoint = await store.addCheckpoint(args.projectId, args); return textResult('Adaptive checkpoint saved.', { checkpoint });
    }
    case 'adaptive_consolidate': {
      const consolidation = await store.consolidate(args.projectId, args); return textResult('Verified project learning consolidated.', { consolidation });
    }
    default: return errorResult(`Unknown tool: ${name}`);
  }
}

export async function dispatch(message) {
  const method = message?.method;
  if (method === 'initialize') return {
    protocolVersion: message.params?.protocolVersion || DEFAULT_PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    instructions: 'Use adaptive routing before substantial qualifying work when budget is unclear. Prefer selective project context over full history, use specialized installed capabilities only when they match the task, and persist only evidence, hypotheses, experiment results, checkpoints, and verified lessons that improve continuity. Workflow budgets are not actual model-token budgets. Do not claim model-weight retraining or permanent self-learning from these records.'
  };
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools };
  if (method === 'tools/call') {
    try { return await callTool(message.params?.name, message.params?.arguments || {}); }
    catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
  }
  if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return undefined;
  throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
}

export async function processRpcMessage(message) {
  const isRequest = Object.prototype.hasOwnProperty.call(message || {}, 'id');
  try {
    const result = await dispatch(message);
    if (!isRequest) return null;
    return { jsonrpc: '2.0', id: message.id, result: result ?? {} };
  } catch (error) {
    if (!isRequest) return null;
    return {
      jsonrpc: '2.0',
      id: message.id ?? null,
      error: {
        code: Number.isInteger(error?.code) ? error.code : -32603,
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

const write = message => process.stdout.write(`${JSON.stringify(message)}\n`);
async function handleLine(line) {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); }
  catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  const response = await processRpcMessage(message);
  if (response) write(response);
}

export function runStdio() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  let queue = Promise.resolve();
  rl.on('line', line => { queue = queue.then(() => handleLine(line)).catch(error => process.stderr.write(`${error?.stack || error}\n`)); });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  if (!process.argv.includes('--stdio')) {
    process.stderr.write('This bundled server supports stdio. Start with: node server/mcp-server.mjs --stdio\n');
    process.exit(2);
  }
  runStdio();
}
