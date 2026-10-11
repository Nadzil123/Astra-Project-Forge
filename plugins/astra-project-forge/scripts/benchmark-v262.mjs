import { mkdtemp, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const archiveSha256 = 'f84fc8a14e4ff75b9c632f4630982bc77a1a1c9b666f859badd96330def5fbcf';
export const benchmarkVariants = {
  v261_uploaded_full: { source: '../tests/fixtures/v261-uploaded/server/', controls: 'full', capsule: false, fusion: false, hostAdvice: false },
  v261_uploaded_compact: { source: '../tests/fixtures/v261-uploaded/server/', controls: 'summary', capsule: false, fusion: false, hostAdvice: false },
  v262_legacy: { source: '../server/', controls: 'full', capsule: false, fusion: false, hostAdvice: false },
  v262_fusion: { source: '../server/', controls: 'full', capsule: false, fusion: true, hostAdvice: false },
  v262_capsule: { source: '../server/', controls: 'capsule', capsule: true, fusion: false, hostAdvice: false },
  v262_combined: { source: '../server/', controls: 'capsule', capsule: true, fusion: true, hostAdvice: true },
};
const controls = new Set(['forge_route', 'forge_plan', 'forge_observe', 'forge_evaluate']);
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const telemetry = { modelTurns: null, modelTokens: null, modelCacheHits: null, billing: null };
const criteria = ['invoice matches current inputs', 'artifact verification', 'currency and discount policy'];
export function benchmarkScenarios() {
  const read = target => ({ type: 'read', target });
  const build = adjustment => ({ type: 'build', adjustment });
  const verify = { type: 'verify' };
  const base = { sources: { 'a.json': { quantity: 2, unitPrice: 5 }, 'b.json': { quantity: 1, unitPrice: 7 } },
    policy: { currency: 'USD', discountAllowed: false }, expected: { total: 17, currency: 'USD' },
    constraints: ['Use USD.', 'Do not apply a discount.'], requireAudit: false };
  return structuredClone([
    { ...base, id: 'ordinary', actions: [read('a.json'), read('b.json'), build(0), verify] },
    { ...base, id: 'old-constraint-counter-evidence', counterEvidence: true,
      actions: [read('policy.json'), read('a.json'), read('b.json'), build(0), verify] },
    { ...base, id: 'changed-dependency', expected: { total: 22, currency: 'USD' }, actions: [read('a.json'),
      { type: 'change', target: 'a.json', value: { quantity: 3, unitPrice: 5 } }, read('a.json'), read('b.json'), build(0), verify] },
    { ...base, id: 'unresolved-risk', requireAudit: true, actions: [read('a.json'), read('b.json'), build(0), verify] },
    { ...base, id: 'recovery-retry', recovery: true, actions: [read('a.json'), read('b.json'), build(-1), verify, build(0), verify] },
  ]);
}

// This oracle reads artifact/source snapshots, independently recomputes totals,
// and checks hashes in persisted verification evidence. It never trusts the
// server's outcome, completion recommendation, or an evidence `passed` flag.
export function verifyBenchmarkArtifacts(artifacts, scenario) {
  const { invoice, sources, policy, verification, audit } = artifacts;
  const total = Object.values(sources).reduce((n, row) => n + row.quantity * row.unitPrice, 0);
  const expected = { total, currency: 'USD' };
  const taskSuccess = isDeepStrictEqual(invoice, expected) && isDeepStrictEqual(invoice, scenario.expected)
    && policy?.currency === 'USD' && policy?.discountAllowed === false;
  const verified = verification?.artifactHash === hash(invoice) && verification?.sourceHash === hash(sources)
    && verification?.policyHash === hash(policy) && isDeepStrictEqual(verification?.expected, expected)
    && isDeepStrictEqual(verification?.actual, invoice) && taskSuccess;
  const audited = audit?.artifactHash === hash(invoice) && audit?.sourceHash === hash(sources)
    && Number.isSafeInteger(invoice?.total) && invoice.total >= 0 && invoice.total <= 100;
  const missingCriteria = [];
  if (!taskSuccess) missingCriteria.push('invoice matches current inputs', 'currency and discount policy');
  if (!verified) missingCriteria.push('artifact verification');
  if (scenario.requireAudit && !audited) missingCriteria.push('risk audit');
  return { taskSuccess, verifiedSuccess: missingCriteria.length === 0, missingCriteria };
}

export async function runBenchmarkScenario(scenario, variant) {
  if (!Object.hasOwn(benchmarkVariants, variant)) throw new TypeError(`Unknown benchmark variant: ${variant}`);
  const start = performance.now();
  return new Promise((resolve, reject) => {
    let result;
    const worker = new Worker(new URL(import.meta.url), { workerData: { scenario, variant } });
    worker.once('message', message => { result = message; }); worker.once('error', reject);
    worker.once('exit', code => {
      if (code !== 0 || !result) return reject(new Error(`Benchmark worker exited ${code} without a result`));
      const elapsedMs = performance.now() - start;
      resolve({ ...result, elapsedMs, otherMs: elapsedMs - result.workMs - result.coordinationMs });
    });
  });
}
async function directoryBytes(directory) {
  let size = 0;
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, item.name);
    size += item.isDirectory() ? await directoryBytes(target) : (await stat(target)).size;
  }
  return size;
}
async function execute(scenario, variant) {
  const config = benchmarkVariants[variant];
  const root = await mkdtemp(path.join(tmpdir(), 'forge-v262-benchmark-'));
  const result = { scenario: scenario.id, variant, config, calls: [], workTrace: [], workCalls: 0,
    workMs: 0, coordinationMs: 0, contextBytes: 0, falseCompletionCount: 0, telemetry, serverReportedCompletion: null };
  const artifacts = { sources: structuredClone(scenario.sources), policy: scenario.policy, invoice: null, verification: null, audit: null };
  try {
    process.env.ASTRA_PROJECT_FORGE_DATA_DIR = path.join(root, 'state');
    const { processRpcMessage } = await import(new URL(`${config.source}mcp-server.mjs`, import.meta.url));
    const projectId = scenario.id;
    const write = (target, data) => writeFile(path.join(root, target), JSON.stringify(data));
    const read = async target => JSON.parse(await readFile(path.join(root, target), 'utf8'));
    const maybeRead = async target => { try { return await read(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
    async function dispatchMeasured(request, category) {
      const start = performance.now();
      // Round trips ensure trace values are the actual JSON dispatch payloads.
      const requestJSON = JSON.stringify({ jsonrpc: '2.0', id: result.calls.length + 1, ...request });
      const response = await processRpcMessage(JSON.parse(requestJSON));
      const responseJSON = JSON.stringify(response);
      const elapsedMs = performance.now() - start;
      const record = { category, request: JSON.parse(requestJSON), response: JSON.parse(responseJSON),
        requestBytes: Buffer.byteLength(requestJSON), responseBytes: Buffer.byteLength(responseJSON), elapsedMs };
      result.calls.push(record); result.coordinationMs += elapsedMs;
      const content = response.result?.structuredContent;
      for (const value of [content?.context, content?.recovery, content?.decisionCapsule, content?.currentDecisionCapsule]) {
        if (value) result.contextBytes += bytes(value);
      }
      const reported = content?.completion ?? content?.decisionCapsule?.completion ?? content?.context?.completion;
      if (reported) result.serverReportedCompletion = reported;
      if (reported?.recommended && !verifyBenchmarkArtifacts(artifacts, scenario).verifiedSuccess) result.falseCompletionCount++;
      if (content?.route?.completionRecommended && !verifyBenchmarkArtifacts(artifacts, scenario).verifiedSuccess) result.falseCompletionCount++;
      if (response.error) throw new Error(JSON.stringify(response.error));
      return response.result;
    }
    async function call(name, args = {}, category = 'coordination', allowError = false) {
      const projection = controls.has(name) && config.controls !== 'full' ? { resultLevel: config.controls } : {};
      const response = await dispatchMeasured({ method: 'tools/call', params: { name, arguments: { projectId, ...projection, ...args } } }, category);
      if (response.isError) { if (allowError) return { error: response.content[0].text }; throw new Error(`${name}: ${response.content[0].text}`); }
      return response.structuredContent;
    }
    for (const [target, data] of Object.entries(artifacts.sources)) await write(target, data);
    await write('policy.json', artifacts.policy);
    await dispatchMeasured({ method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'v262-deterministic-benchmark', version: '1' } } }, 'setup');
    await dispatchMeasured({ method: 'tools/list' }, 'discovery');
    await call('adaptive_initialize_project', { goal: 'Produce and verify the invoice under the recorded policy',
      successCriteria: [...criteria, ...(scenario.requireAudit ? ['risk audit'] : [])], constraints: scenario.constraints }, 'setup');
    await call('forge_adapt', { operation: 'acknowledge_usage', firstUseNoticeAcknowledged: true, deepWarningAcknowledged: true }, 'setup');
    let claimId;
    if (scenario.counterEvidence) {
      const evidenceRecord = { evidenceId: 'policy-proof', kind: 'policy', target: 'policy.json', dependencies: [`policy:${hash(scenario.policy)}`],
        dependencyIds: ['policy.json'], freshness: 'fresh', result: scenario.policy };
      await call('forge_observe', { operation: 'observation', observation: 'Original policy forbids discount and fixes USD', evidence: 'policy.json', evidenceRecord }, 'setup');
      claimId = (await call('forge_observe', { operation: 'claim', statement: 'A discount may be allowed', claimStatus: 'contradicted', counterEvidenceIds: ['policy-proof'] }, 'setup')).claim.id;
      await call('forge_checkpoint', { summary: 'Resume invoice; resolve the existing policy contradiction before completing', remainingUnknowns: [] }, 'setup');
    }
    if (scenario.requireAudit) await call('forge_checkpoint', { summary: 'Audit is required before release', remainingUnknowns: ['risk audit is outstanding'] }, 'setup');
    const initial = (await call('forge_context', { detail: 'full' }, 'support')).context.project;
    const epoch = initial.coordination?.epoch;
    const inputs = new Map();
    let lastEvaluationRequest;
    for (const [index, action] of scenario.actions.entries()) {
      const before = verifyBenchmarkArtifacts(artifacts, scenario);
      const route = await call('forge_route', { complexity: 'moderate', uncertainty: 'medium', completedCycles: result.workCalls,
        unmetSuccessCriteria: before.missingCriteria, candidateWouldProduceNewEvidence: true,
        ...(config.fusion && config.capsule ? { includeContext: true } : {}),
        ...(config.hostAdvice ? { hostCapabilities: { deferredDiscovery: true, discoveryAvailable: true } } : {}) }, config.hostAdvice ? 'advisory' : 'coordination');
      const context = config.fusion && config.capsule ? route.decisionCapsule : (await call('forge_context', config.capsule
        ? { resultLevel: 'capsule', maxItems: 5 } : { detail: 'working', resultLevel: 'relevant', maxItems: 5 }, 'context')).context;
      if (scenario.counterEvidence && index === 0) {
        if (config.capsule) {
          const refs = context.refs.filter(ref => ref.kind === 'evidence');
          const expanded = (await call('forge_context', { references: refs, resultLevel: 'full' }, 'expansion')).context.references;
          if (!expanded.some(item => item.record?.result?.discountAllowed === false)) throw new Error('Policy counter-evidence was not recovered');
        } else {
          const full = (await call('forge_context', { detail: 'full' }, 'expansion')).context.project;
          if (!full.efficiency.evidenceCache.some(item => item.result?.discountAllowed === false)) throw new Error('Policy counter-evidence was not recovered');
        }
      }
      const strategyKey = `${action.type}:${action.target ?? 'invoice.json'}`;
      const planArgs = { action: strategyKey, why: 'Obtain the next required artifact or evidence', expectedEvidence: 'File output verified against current source identities',
        strategyKey, changedConditions: hash({ sources: artifacts.sources, invoice: artifacts.invoice }),
        goalId: 'goal-root', risk: 'low', usageImpact: ['build', 'verify'].includes(action.type) ? 'MODERATE' : 'LOW', completedCycles: result.workCalls,
        ...(result.workCalls >= route.route.softCycleBudget && ['build', 'verify'].includes(action.type)
          ? { budgetOverride: { category: 'unmet_success_criterion', justification: `The invoice still requires ${before.missingCriteria.join(', ')}; execute ${strategyKey} to obtain evidence.` } } : {}) };
      const planned = await call('forge_plan', planArgs);
      const start = performance.now(); let output;
      switch (action.type) {
        case 'read': output = await read(action.target); inputs.set(action.target, output); break;
        case 'change': await write(action.target, action.value); artifacts.sources[action.target] = action.value; inputs.delete(action.target); output = action.value; break;
        case 'build': {
          const policy = inputs.get('policy.json') ?? artifacts.policy;
          artifacts.invoice = { total: Object.keys(artifacts.sources).reduce((n, target) => n + inputs.get(target).quantity * inputs.get(target).unitPrice, action.adjustment), currency: policy.currency };
          await write('invoice.json', artifacts.invoice); output = artifacts.invoice; break;
        }
        case 'verify': {
          const actual = await read('invoice.json'); const sources = {};
          for (const target of Object.keys(scenario.sources)) sources[target] = await read(target);
          const policy = await read('policy.json');
          const expected = { total: Object.values(sources).reduce((n, row) => n + row.quantity * row.unitPrice, 0), currency: 'USD' };
          output = { actual, expected, artifactHash: hash(actual), sourceHash: hash(sources), policyHash: hash(policy),
            passed: isDeepStrictEqual(actual, expected) && policy.discountAllowed === false };
          artifacts.verification = output; await write('verification.json', output); break;
        }
        default: throw new TypeError(`Unknown action: ${action.type}`);
      }
      result.workMs += performance.now() - start; result.workCalls++;
      result.workTrace.push({ action, output: structuredClone(output) });
      const quality = verifyBenchmarkArtifacts(artifacts, scenario);
      const evidenceId = `work:${index}`;
      const record = { evidenceId, kind: action.type, target: action.target ?? 'invoice.json',
        dependencies: Object.entries(artifacts.sources).map(([target, value]) => `${target}:${hash(value)}`),
        dependencyIds: Object.keys(artifacts.sources), freshness: 'fresh', result: output };
      const event = { type: 'usefulCycles', amount: 1, provenance: { source: 'reported', reference: evidenceId } };
      const claimUpdates = scenario.counterEvidence && action.type === 'verify' && output.passed
        ? [{ claimId, statement: 'The invoice complies with the no-discount USD policy', status: 'known', evidenceIds: [evidenceId], counterEvidenceIds: [] }] : [];
      const evaluation = { planId: planned.plan.id, outcome: output.passed === false ? 'falsified' : action.type === 'verify' ? 'verified' : 'partially_verified',
        summary: JSON.stringify(output), evidenceIds: [evidenceId], missingCriteria: quality.missingCriteria };
      if (config.fusion) {
        const request = { ...evaluation, coordination: { operationId: `work-${index}`, stateEpoch: epoch, expectedRevision: planned.plan.revision,
          evidenceRecords: [record], efficiencyEvents: [event], claimUpdates,
          ...(action.type === 'change' ? { changedDependencyIds: [action.target] } : {}),
          criteriaUpdates: action.type === 'verify' ? [...criteria, ...(scenario.requireAudit ? ['risk audit'] : [])].map(criterion => ({ goalId: 'goal-root', criterion,
            satisfied: !quality.missingCriteria.includes(criterion), evidenceIds: [evidenceId] })) : [] } };
        await call('forge_evaluate', request); lastEvaluationRequest = request;
      } else {
        await call('forge_observe', { operation: 'observation', observation: JSON.stringify(output), evidence: evidenceId, evidenceRecord: record });
        if (action.type === 'change') await call('forge_adapt', { operation: 'invalidate_evidence', changedDependencyIds: [action.target] });
        for (const update of claimUpdates) {
          const { status, ...fields } = update;
          await call('forge_observe', { operation: 'update_claim', ...fields, claimStatus: status });
        }
        const { type, ...fields } = event;
        await call('forge_adapt', { operation: 'record_efficiency_event', eventType: type, ...fields });
        await call('forge_evaluate', evaluation); lastEvaluationRequest = evaluation;
      }
      if (scenario.recovery && output.passed === false) {
        const rejection = await call('forge_plan', planArgs, 'retry', true);
        if (!rejection.error?.includes('Failed strategy cannot be repeated unchanged')) throw new Error('Unchanged failed strategy must reject');
        await call('forge_context', { detail: 'recovery', resultLevel: 'full' }, 'recovery');
        await call('forge_adapt', { operation: 'failure', failureCategory: 'implementation_defect', failedAction: strategyKey,
          diagnosis: 'Invoice total differs from independently computed current inputs', nextStrategy: 'Rebuild without the erroneous adjustment before verifying again', newEvidenceIds: [evidenceId] }, 'recovery');
      }
    }
    if (scenario.recovery && lastEvaluationRequest) {
      if (config.fusion) {
        const replay = await call('forge_evaluate', lastEvaluationRequest, 'replay');
        if (!replay.replayed) throw new Error('Committed response loss must replay');
        const stale = structuredClone(lastEvaluationRequest); stale.coordination.operationId = 'stale-new-operation';
        const conflict = await call('forge_evaluate', stale, 'conflict', true);
        if (!conflict.error?.match(/revision conflict/i)) throw new Error('Stale new operation must conflict');
      }
      // Legacy has no idempotency key: inspect persistence after simulated reply
      // loss instead of pretending a blind duplicate evaluation is safe.
      await call('forge_context', { detail: 'full' }, 'retry-support');
    }
    const state = (await call('forge_context', { detail: 'full' }, 'support')).context.project;
    // Re-read the actual files after execution; do not certify the work log.
    const finalSources = {};
    for (const target of Object.keys(scenario.sources)) finalSources[target] = await read(target);
    result.artifacts = { sources: finalSources, policy: await read('policy.json'), invoice: await maybeRead('invoice.json'),
      verification: await maybeRead('verification.json'), audit: await maybeRead('audit.json') };
    Object.assign(result, verifyBenchmarkArtifacts(result.artifacts, scenario));
    result.state = state;
    result.counterEvidenceResolved = !scenario.counterEvidence || state.claims.some(item => item.id === claimId && item.status === 'known' && item.counterEvidenceIds.length === 0);
    if (!result.counterEvidenceResolved) { result.verifiedSuccess = false; result.missingCriteria.push('unresolved counter-evidence'); }
    result.storageBytes = await directoryBytes(path.join(root, 'state'));
    result.artifactBytes = (await directoryBytes(root)) - result.storageBytes;
  } finally { await rm(root, { recursive: true, force: true }); }
  result.coordinationCalls = result.calls.length;
  result.coordinationToolCalls = result.calls.filter(call => call.request.method === 'tools/call').length;
  result.requestBytes = result.calls.reduce((n, call) => n + call.requestBytes, 0);
  result.responseBytes = result.calls.reduce((n, call) => n + call.responseBytes, 0);
  result.combinedBytes = result.requestBytes + result.responseBytes;
  for (const category of ['expansion', 'replay', 'conflict', 'recovery', 'advisory']) result[`${category}Calls`] = result.calls.filter(call => call.category === category).length;
  result.retryCalls = result.calls.filter(call => ['retry', 'replay', 'retry-support'].includes(call.category)).length;
  result.errorCalls = result.calls.filter(call => (call.response.result?.isError || call.response.error)).length;
  return result;
}
const additive = ['coordinationCalls', 'coordinationToolCalls', 'workCalls', 'requestBytes', 'responseBytes', 'combinedBytes', 'contextBytes', 'storageBytes', 'artifactBytes',
  'expansionCalls', 'replayCalls', 'conflictCalls', 'retryCalls', 'recoveryCalls', 'advisoryCalls', 'errorCalls', 'falseCompletionCount'];
export function summarizeLatency(samplesMs) {
  const timings = [...samplesMs].sort((a, b) => a - b);
  const middle = Math.floor(timings.length / 2);
  return { samplesMs, medianMs: timings.length % 2 ? timings[middle] : (timings[middle - 1] + timings[middle]) / 2, maxMs: timings.at(-1) };
}
export const describeTiming = repetitions => `${repetitions} isolated-store workers per pair, sequential fixed variant order; elapsed includes startup, filesystem work, dispatch locking/serialization/I/O, final checks and cleanup. coordinationMs includes dispatch and JSON serialization, workMs includes useful file operations, otherMs includes all remaining harness/worker overhead. Median and maximum of ${repetitions} are descriptive, not robust production percentiles. No contention benchmark or host transport/model latency.`;
export async function runBenchmark({ repetitions = 3 } = {}) {
  if (!Number.isInteger(repetitions) || repetitions < 3) throw new TypeError('At least three latency repetitions are required');
  const comparisons = [];
  for (const scenario of benchmarkScenarios()) {
    const results = [];
    for (const variant of Object.keys(benchmarkVariants)) {
      const samples = [];
      for (let index = 0; index < repetitions; index++) samples.push(await runBenchmarkScenario(scenario, variant));
      results.push({ ...samples[0], latency: summarizeLatency(samples.map(item => item.elapsedMs)), repetitions: samples });
    }
    comparisons.push({ scenario: scenario.id, qualityRegression: results.some(result => result.repetitions.some(sample => !sample.taskSuccess || sample.verifiedSuccess !== (scenario.id !== 'unresolved-risk') || sample.falseCompletionCount > 0)), results });
  }
  const totals = Object.keys(benchmarkVariants).map(variant => {
    const runs = comparisons.map(item => item.results.find(result => result.variant === variant));
    return { variant, scenarioCount: runs.length, taskSuccessCount: runs.filter(item => item.taskSuccess).length,
      verifiedSuccessCount: runs.filter(item => item.verifiedSuccess).length,
      serverReportedCompletionCount: runs.filter(item => item.serverReportedCompletion?.recommended).length,
      ...Object.fromEntries(additive.map(key => [key, runs.reduce((n, item) => n + item[key], 0)])),
      elapsedSamplesMs: Array.from({ length: repetitions }, (_, index) => runs.reduce((n, item) => n + item.latency.samplesMs[index], 0)), telemetry };
  });
  const sourceHashes = {};
  for (const directory of ['../server/', '../tests/fixtures/v261-uploaded/server/']) {
    sourceHashes[directory] = {};
    for (const file of (await readdir(new URL(directory, import.meta.url))).sort()) {
      sourceHashes[directory][file] = createHash('sha256').update(await readFile(new URL(directory + file, import.meta.url))).digest('hex');
    }
  }
  return { sourceHashes, workloadSha256: hash(benchmarkScenarios()), benchmark: 'Deterministic file-workload / actual MCP dispatch comparison; not model evaluation', archiveSha256,
    runtime: { node: process.version, platform: process.platform, architecture: process.arch }, variants: benchmarkVariants,
    methods: {
      workload: 'Same ordered useful file operations, source files, fixed oracle and criteria; no filler workload. Raw traces include every dispatch, setup, discovery, support, advisory response, expansion, retry and error.',
      bytes: 'UTF-8 JSON of actual processRpcMessage request and entire response, including jsonrpc/id/result/error envelopes and text/structuredContent wrappers. Stdio newline delimiters are excluded (one byte per request/response); OS pipe transport is not timed. Context bytes are a response subset, never added again.',
      completion: 'verifiedSuccess is the independent file oracle plus resolved policy counter-evidence. Server structural completion is reported separately: null in uploaded and v262 legacy modes because they return no structural completion. v262 capsule lacks explicit criterion assessments and remains false despite independently successful work.',
      timing: describeTiming(repetitions),
      storage: 'Final bytes of all store files after all support/retry/error calls; includes persisted operation replay receipts, references and ledger effects. artifactBytes reported separately; no peak-memory or power-loss claim.',
      aggregation: 'Counts/bytes/storage totals sum first samples; all repetitions and raw requests/responses retained. elapsedSamplesMs sums matching repetition indices. UUIDs/timestamps may change byte counts slightly; do not compare fictional normalized wire payloads.',
      host: 'Only combined opts into hostCapabilities advice. Actual tools/list still sends 19 schemas and is counted in all modes. No deferred discovery integration, allowed-tools enforcement, cache savings, tokens, billing or model turns measured.',
    }, modelEvaluation: { status: 'not_run', telemetry, dataset: 'docs/model-evaluation-v262.json' }, comparisons, totals };
}
if (!isMainThread) parentPort.postMessage(await execute(workerData.scenario, workerData.variant));
else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runBenchmark(); console.log(JSON.stringify(report, null, 2));
  if (report.comparisons.some(item => item.qualityRegression)) process.exitCode = 1;
}
