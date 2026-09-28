import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const versions = ['v260_baseline', 'v261_verified', 'v261_compact'];
const runtimeSources = {
  v260_baseline: '../tests/fixtures/v260-baseline/server/',
  v261_verified: '../tests/fixtures/v261-verified/server/',
  v261_compact: '../server/',
  v261_efficiency: '../server/',
};
const compactControls = new Set(['forge_route', 'forge_plan', 'forge_observe', 'forge_evaluate']);
const additiveMetrics = [
  'cycles', 'toolCalls', 'duplicateToolCalls', 'usefulActions', 'reusedEvidence', 'retries',
  'coordinationToolCalls', 'harnessOperations', 'totalToolCalls', 'totalOperations', 'contextBytes', 'contextUnits',
  'coordinationRequestBytes', 'coordinationResponseBytes', 'coordinationCombinedBytes',
  'elapsedMs', 'workMs', 'coordinationMs', 'harnessMs', 'otherMs',
];
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const units = value => value !== null && typeof value === 'object'
  ? Object.values(value).reduce((sum, child) => sum + units(child), 0) : 1;

export function benchmarkScenarios() {
  const read = target => ({ type: 'read', target });
  const build = adjustment => ({ type: 'build', target: 'artifact.json', adjustment });
  const verify = { type: 'verify', target: 'artifact.json' };
  const audit = { type: 'audit', target: 'artifact.json' };
  const extra = read('unneeded.json');
  const base = {
    softBudget: 3, efficiencyPolicy: 'balanced',
    routing: { complexity: 'moderate', uncertainty: 'medium' },
    sources: { 'a.json': { quantity: 2, unitPrice: 5 }, 'b.json': { quantity: 1, unitPrice: 7 } },
    expected: { total: 17 }, requireAudit: false,
  };
  return structuredClone([
    { ...base, id: 'duplicate-heavy',
      actions: [read('a.json'), read('a.json'), read('a.json'), read('b.json'), build(0), verify, extra] },
    { ...base, id: 'useful-over-budget', softBudget: 2, efficiencyPolicy: 'eco',
      routing: { complexity: 'complex', uncertainty: 'high', continuityNeeded: true },
      sources: { ...base.sources, 'c.json': { quantity: 3, unitPrice: 2 }, 'd.json': { quantity: 1, unitPrice: 4 } },
      expected: { total: 27 }, requireAudit: true,
      actions: [read('a.json'), read('b.json'), read('c.json'), read('d.json'), build(0), audit, verify, extra] },
    { ...base, id: 'changed-dependency', expected: { total: 22 },
      actions: [read('a.json'), { type: 'change', target: 'a.json', value: { quantity: 3, unitPrice: 5 } },
        read('a.json'), read('b.json'), build(0), verify, extra] },
    { ...base, id: 'unresolved-risk', requireAudit: true,
      actions: [read('a.json'), read('b.json'), build(0), verify] },
    { ...base, id: 'unchanged-retry',
      actions: [read('a.json'), read('b.json'), build(-1), verify, verify, build(0), verify, extra] },
    { ...base, id: 'context-resume',
      actions: [read('a.json'), { type: 'context', detail: 'summary' }, read('b.json'),
        { type: 'context', detail: 'working' }, { type: 'context', detail: 'summary' },
        { type: 'context', detail: 'working' }, build(0), verify, extra] },
  ]);
}

// Workers isolate the MCP module's environment-selected singleton store, even
// when callers run scenarios concurrently. No host data directory is touched.
export async function runBenchmarkScenario(scenario, version) {
  if (!Object.hasOwn(runtimeSources, version)) throw new TypeError(`Unknown benchmark version: ${version}`);
  const start = performance.now();
  return new Promise((resolve, reject) => {
    let result;
    const worker = new Worker(new URL(import.meta.url), { workerData: { scenario, version } });
    worker.once('message', message => { result = message; });
    worker.once('error', reject);
    worker.once('exit', code => {
      if (code !== 0 || !result) return reject(new Error(`Benchmark worker exited ${code} without a result`));
      const elapsedMs = performance.now() - start;
      resolve({ ...result, elapsedMs,
        otherMs: elapsedMs - result.workMs - result.coordinationMs - result.harnessMs });
    });
  });
}

async function executeScenario(scenario, version) {
  const efficient = version !== 'v260_baseline';
  const result = {
    scenario: scenario.id, version, cycles: 0, toolCalls: 0, duplicateToolCalls: 0,
    usefulActions: 0, contextUnits: 0, contextBytes: 0, reusedEvidence: 0, retries: 0,
    coordinationToolCalls: 0, harnessOperations: 0, workMs: 0, coordinationMs: 0, harnessMs: 0,
    trace: [], contexts: [], calls: [], verifications: [], harnessActions: [],
    stopReason: 'workload_exhausted',
    telemetry: { modelTurns: null, modelTokens: null, modelCacheHits: null, billing: null },
  };
  async function harnessWork(name, operation) {
    const start = performance.now();
    result.harnessOperations += 1;
    result.harnessActions.push(name);
    try { return await operation(); }
    finally { result.harnessMs += performance.now() - start; }
  }
  const directory = await harnessWork('create temporary directory', () => mkdtemp(path.join(tmpdir(), 'forge-benchmark-')));
  try {
    const source = runtimeSources[version];
    process.env.ASTRA_PROJECT_FORGE_DATA_DIR = path.join(directory, 'state');
    const { dispatch } = await harnessWork('load production MCP module', () => import(new URL(`${source}mcp-server.mjs`, import.meta.url)));
    const { ProjectStore } = await harnessWork('load production store inspector', () => import(new URL(`${source}state-store.mjs`, import.meta.url)));
    const projectId = scenario.id;
    async function call(name, args, allowError = false) {
      const request = { method: 'tools/call', params: { name, arguments: { projectId, ...args } } };
      if (version === 'v261_compact' && compactControls.has(name)) request.params.arguments.resultLevel = 'summary';
      const requestBytes = bytes(request);
      const start = performance.now();
      const response = await dispatch(request);
      const elapsedMs = performance.now() - start;
      result.coordinationMs += elapsedMs;
      result.coordinationToolCalls += 1;
      result.calls.push({ name, elapsedMs, request, response, requestBytes, responseBytes: bytes(response), isError: response.isError === true });
      if (response.isError) {
        if (allowError) return { error: response.content[0].text };
        throw new Error(`${name}: ${response.content[0].text}`);
      }
      return response.structuredContent;
    }
    const writeJSON = (target, value) => writeFile(path.join(directory, target), JSON.stringify(value));
    const readJSON = async target => JSON.parse(await readFile(path.join(directory, target), 'utf8'));
    const sources = structuredClone(scenario.sources);
    const dependencies = Object.fromEntries(Object.entries(sources).map(([target, value]) => [target, digest(value)]));
    for (const [target, value] of Object.entries(sources)) {
      await harnessWork(`seed ${target}`, () => writeJSON(target, value));
    }
    await harnessWork('seed risk rules', () => writeJSON('risk-rules.json', { maximumTotal: 100 }));
    await harnessWork('seed optional work', () => writeJSON('unneeded.json', { optional: true }));
    await call('adaptive_initialize_project', { goal: 'Produce and verify the invoice total',
      successCriteria: ['expected artifact', 'artifact verification', ...(scenario.requireAudit ? ['risk audit'] : [])] });

    const inputs = new Map();
    const seenResults = new Set();
    const failedStrategies = new Set();
    let artifact = null;
    let auditEvidence = null;
    let cursor;
    const sourceIdentity = () => digest(dependencies);
    const quality = () => {
      const taskSuccess = isDeepStrictEqual(artifact, scenario.expected);
      const verification = result.verifications.at(-1);
      const verified = verification?.passed === true && verification.artifactHash === digest(artifact)
        && verification.sourceIdentity === sourceIdentity();
      const audited = !scenario.requireAudit || (auditEvidence?.passed === true
        && auditEvidence.artifactHash === digest(artifact) && auditEvidence.sourceIdentity === sourceIdentity());
      const missingCriteria = [!taskSuccess && 'expected artifact', !verified && 'artifact verification', !audited && 'risk audit'].filter(Boolean);
      return { taskSuccess, verifiedSuccess: missingCriteria.length === 0, missingCriteria };
    };
    async function context(detail) {
      const request = { detail, maxItems: 3 };
      if (efficient) {
        request.resultLevel = 'summary';
        if (cursor !== undefined) request.sinceRevision = cursor;
      }
      const { context: value } = await call('forge_context', request);
      const contextBytes = bytes(value);
      const contextUnits = units(value);
      result.contextBytes += contextBytes;
      result.contextUnits += contextUnits;
      result.contexts.push({ request, context: value, bytes: contextBytes, units: contextUnits });
      if (efficient) cursor = value.revision;
    }

    // The fixed candidate schedule models a caller with redundant requests.
    // All versions share artifact/evidence checks and the completion gate.
    for (const action of [...scenario.actions, { type: 'finish' }]) {
      const completion = quality();
      const cacheRequest = action.type === 'read' ? {
        kind: 'read', target: action.target, params: null,
        dependencies: [`${action.target}@${dependencies[action.target]}`],
      } : null;
      const routed = await call('forge_route', {
        ...scenario.routing,
        ...(efficient ? {
          efficiencyPolicy: scenario.efficiencyPolicy, completedCycles: result.cycles,
          successCriteriaSatisfied: completion.taskSuccess,
          evidenceSufficient: !completion.missingCriteria.includes('artifact verification'),
          contradictionRemaining: !completion.taskSuccess,
          meaningfulRiskRemaining: completion.missingCriteria.includes('risk audit'),
          candidateWouldVerifySuccessCriterion: action.type === 'verify',
          candidateWouldReduceRisk: action.type === 'audit',
          candidateWouldProduceNewEvidence: ['read', 'build', 'change'].includes(action.type),
          ...(cacheRequest && !completion.verifiedSuccess ? { cacheRequest } : {}),
        } : {}),
      });
      result.finalRoute = routed.route;
      result.softBudget = routed.route.softCycleBudget ?? routed.route.cycleBudget;
      if (completion.verifiedSuccess) {
        result.stopReason = 'verified_success';
        break;
      }
      if (action.type === 'finish') break;
      if (action.type === 'context') {
        await context(action.detail);
        continue;
      }
      if (routed.evidenceRecord) {
        inputs.set(action.target, routed.evidenceRecord.result);
        result.reusedEvidence += 1;
        result.trace.push({ ...action, status: 'reused', result: routed.evidenceRecord.result });
        continue;
      }
      if (['skip', 'stop'].includes(routed.route.efficiencyDecision)) {
        result.trace.push({ ...action, status: 'skipped', decision: routed.route.efficiencyDecision });
        continue;
      }
      await context(routed.route.stateDetail === 'working' ? 'working' : 'summary');
      const strategyKey = `${action.type}:${action.target}`;
      const conditions = digest({ sources: dependencies, artifact });
      const planInput = { action: strategyKey, why: `Obtain ${action.type} evidence for the invoice criteria`,
        expectedEvidence: 'Serialized operation result checked against the invoice criteria',
        risk: action.type === 'audit' ? 'high' : 'low', usageImpact: ['build', 'audit', 'verify'].includes(action.type) ? 'MODERATE' : 'LOW',
        ...(efficient ? { strategyKey, changedConditions: conditions, completedCycles: result.cycles,
          efficiencyPolicy: scenario.efficiencyPolicy } : {}),
      };
      if (efficient && result.cycles >= routed.route.softCycleBudget && planInput.usageImpact === 'MODERATE') {
        planInput.budgetOverride = {
          category: action.type === 'audit' ? 'high_risk_verification' : 'unmet_success_criterion',
          justification: `The invoice still lacks ${completion.missingCriteria.join(' and ')}; ${strategyKey} provides the required artifact or evidence.`,
        };
      }
      const planned = await call('forge_plan', planInput, true);
      if (planned.error) {
        if (!/^Failed strategy cannot be repeated unchanged/.test(planned.error)) throw new Error(planned.error);
        result.trace.push({ ...action, status: 'rejected', error: planned.error });
        continue;
      }

      const start = performance.now();
      let output;
      switch (action.type) {
        case 'read':
          output = await readJSON(action.target);
          inputs.set(action.target, output);
          break;
        case 'change':
          await writeJSON(action.target, action.value);
          dependencies[action.target] = digest(action.value);
          sources[action.target] = action.value;
          inputs.delete(action.target);
          output = { changed: action.target, value: action.value };
          break;
        case 'build':
          artifact = { total: Object.keys(sources).reduce((sum, key) => {
            const input = inputs.get(key);
            if (!input) throw new Error(`Missing input: ${key}`);
            return sum + input.quantity * input.unitPrice;
          }, action.adjustment ?? 0) };
          await writeJSON(action.target, artifact);
          output = artifact;
          break;
        case 'verify': {
          const actual = await readJSON(action.target);
          output = { actual, expected: scenario.expected, passed: isDeepStrictEqual(actual, scenario.expected),
            artifactHash: digest(actual), sourceIdentity: sourceIdentity() };
          result.verifications.push(output);
          break;
        }
        case 'audit': {
          const actual = await readJSON(action.target);
          const rules = await readJSON('risk-rules.json');
          output = { passed: Number.isSafeInteger(actual.total) && actual.total >= 0 && actual.total <= rules.maximumTotal,
            artifactHash: digest(actual), sourceIdentity: sourceIdentity() };
          auditEvidence = output;
          break;
        }
        default: throw new Error(`Unknown workload operation: ${action.type}`);
      }
      result.workMs += performance.now() - start;
      result.toolCalls += 1;
      result.cycles += 1;
      const identity = digest({ action, conditions, output });
      const duplicate = seenResults.has(identity);
      seenResults.add(identity);
      result.duplicateToolCalls += Number(duplicate);
      result.usefulActions += Number(!duplicate);
      const retry = failedStrategies.has(strategyKey);
      result.retries += Number(retry);
      if (output.passed === false) failedStrategies.add(strategyKey);
      result.trace.push({ ...action, status: 'executed', result: output, duplicate, retry, plan: planned.plan });

      if (efficient && action.type === 'change') {
        await call('forge_adapt', { operation: 'invalidate_evidence', changedDependencyIds: [action.target] });
      }
      const observation = await call('forge_observe', { operation: 'observation', observation: JSON.stringify(output),
        evidence: `workload:${result.toolCalls}:${strategyKey}`,
        ...(efficient && cacheRequest ? { evidenceRecord: {
          ...cacheRequest, evidenceId: `workload:${result.toolCalls}`, dependencyIds: [action.target], freshness: 'fresh', result: output,
        } } : {}),
      });
      await call('forge_evaluate', { planId: planned.plan.id,
        outcome: output.passed === false ? 'falsified' : ['verify', 'audit'].includes(action.type) ? 'verified' : 'partially_verified',
        summary: JSON.stringify(output), evidenceIds: [observation.observation.id], missingCriteria: quality().missingCriteria });
    }
    // Inspect persisted state and the on-disk artifact independently of the
    // execution log. These inspections are counted as harness work, not tools.
    const state = await harnessWork('inspect persisted project', () => new ProjectStore(path.join(directory, 'state')).getProject(projectId));
    artifact = await harnessWork('inspect final artifact', async () => {
      try { return await readJSON('artifact.json'); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    });
    Object.assign(result, quality(), { artifact, ledger: state.efficiency?.ledger ?? null,
      evidenceCache: state.efficiency?.evidenceCache ?? [], failedStrategies: state.efficiency?.failedStrategies ?? [] });
  } finally {
    await harnessWork('remove temporary directory', () => rm(directory, { recursive: true, force: true }));
  }
  result.totalToolCalls = result.toolCalls + result.coordinationToolCalls;
  result.totalOperations = result.totalToolCalls + result.harnessOperations;
  result.coordinationRequestBytes = result.calls.reduce((sum, call) => sum + call.requestBytes, 0);
  result.coordinationResponseBytes = result.calls.reduce((sum, call) => sum + call.responseBytes, 0);
  result.coordinationCombinedBytes = result.coordinationRequestBytes + result.coordinationResponseBytes;
  return result;
}

function pairwiseDeltas(results) {
  return Object.fromEntries([[0, 1], [0, 2], [1, 2]].map(([from, to]) => [
    `${results[to].version}_vs_${results[from].version}`,
    Object.fromEntries(additiveMetrics.map(key => [key, results[to][key] - results[from][key]])),
  ]));
}

async function main() {
  const comparisons = [];
  for (const scenario of benchmarkScenarios()) {
    const results = [];
    for (const version of versions) {
      const result = await runBenchmarkScenario(scenario, version);
      const { trace, contexts, calls, harnessActions, ledger, evidenceCache, failedStrategies, ...metrics } = result;
      results.push(metrics);
    }
    const [baseline, verified, compact] = results;
    const deltas = pairwiseDeltas(results);
    comparisons.push({ scenario: scenario.id, results,
      qualityRegression: (baseline.verifiedSuccess && (!verified.verifiedSuccess || !compact.verifiedSuccess))
        || (verified.verifiedSuccess && !compact.verifiedSuccess),
      delta: deltas.v261_compact_vs_v260_baseline, deltas });
  }
  const totals = versions.map(version => {
    const runs = comparisons.map(item => item.results.find(result => result.version === version));
    return { version, scenarioCount: runs.length,
      taskSuccessCount: runs.filter(result => result.taskSuccess).length,
      verifiedSuccessCount: runs.filter(result => result.verifiedSuccess).length,
      ...Object.fromEntries(additiveMetrics.map(key => [key, runs.reduce((sum, result) => sum + result[key], 0)])),
      telemetry: runs[0].telemetry };
  });
  console.log(JSON.stringify({
    benchmark: 'Deterministic Node/library workload benchmark; not real model runs',
    baselineCommit: '267870465ef6c5fe69512c3d217d632f51c6b0af',
    verifiedBaselineCommit: 'cd0edae9921c80784e11ce3bcaec57f29c224786',
    runtime: { node: process.version, platform: process.platform, architecture: process.arch },
    methods: {
      driver: 'Same ordered candidates, seeded files, expected artifacts and completion checks; real MCP dispatch and isolated stores. Baseline budgets are guidance only.',
      versions: 'v260_baseline and v261_verified use immutable fixtures; v261_compact uses current production, opting into summary only for route/plan/observe/evaluate. Both v261 modes retain the existing summary/delta context requests. Legacy v261_efficiency remains current production with full controls.',
      cycles: 'Executed workload operations; reuse, context retrieval and rejected plans do not execute a cycle.',
      toolCalls: 'Executed file-workload capability invocations, not model tool usage. An audit invocation reads artifact and risk rules.',
      duplicateToolCalls: 'Executed operations with the same action, input conditions and produced result as an earlier execution.',
      usefulActions: 'Executed operations producing a new action/input/result identity, including first failures that supply new evidence.',
      contextUnits: 'JSON primitive or null leaf values in actually delivered forge_context structured context; not tokens.',
      contextBytes: 'UTF-8 JSON bytes of those contexts. Included also in coordination response bytes; do not add twice.',
      reusedEvidence: 'Actual returned and consumed cache records, cross-checkable against store ledger events.',
      retries: 'Executed strategies after an earlier failure, including justified retries after changed conditions.',
      coordinationToolCalls: 'All actual MCP tools/call dispatches, including initialization, reads, writes and rejected plans.',
      coordinationRequestBytes: 'UTF-8 JSON.stringify bytes of actual MCP dispatch requests, including resultLevel opt-in fields. No estimated token conversion or transport-envelope bytes.',
      coordinationResponseBytes: 'UTF-8 JSON.stringify bytes of actual MCP dispatch responses, including wrappers, content, structuredContent and errors.',
      coordinationCombinedBytes: 'Request plus response bytes; contextBytes is a response subset and is not added again.',
      deltas: 'Each named pair is later version minus named baseline, for all additive metrics; delta is the compact-versus-v260 alias. Totals sum the six runs per version.',
      totalToolCalls: 'Workload capability invocations plus MCP coordination calls.',
      harnessOperations: 'Temporary directory creation, module loads, fixture writes, final inspections and cleanup, counted as named operations.',
      totalOperations: 'Total tool calls plus harness operations; not a syscall or model-turn count.',
      timing: 'Variable local samples in actual milliseconds, one run per workload/version; not a speed guarantee. elapsedMs spans worker startup through cleanup and exit; workMs, coordinationMs and harnessMs time disjoint operations. otherMs includes startup, serialization and driver overhead. No exact timing assertions.',
      telemetry: 'Model turns, model tokens, host cache hits and billing are unavailable (null). Store evidence reuse is not host cache telemetry.',
    }, comparisons, totals, deltas: pairwiseDeltas(totals),
  }, null, 2));
  if (comparisons.some(item => item.qualityRegression)) process.exitCode = 1;
}

if (!isMainThread) parentPort.postMessage(await executeScenario(workerData.scenario, workerData.version));
else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
