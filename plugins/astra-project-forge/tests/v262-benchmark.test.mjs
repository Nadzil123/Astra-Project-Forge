import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const variants = ['v261_uploaded_full', 'v261_uploaded_compact', 'v262_legacy', 'v262_fusion', 'v262_capsule', 'v262_combined'];
const wire = x => Buffer.byteLength(JSON.stringify(x));
async function harness() {
  assert.ok(existsSync(new URL('../scripts/benchmark-v262.mjs', import.meta.url)), 'six-variant benchmark is implemented');
  return import('../scripts/benchmark-v262.mjs');
}
// A replaced provenance manifest or changed baseline runtime must fail independently.
test('uploaded v261 baseline bytes match independently frozen archive provenance', async () => {
  const base = new URL('./fixtures/v261-uploaded/', import.meta.url);
  const raw = await readFile(new URL('provenance.json', base));
  assert.equal(createHash('sha256').update(raw).digest('hex'), '162a658e70ed1917b5bd5c17c2422c36f80c73b3b1104a8a502663c93832f9e4');
  const provenance = JSON.parse(raw);
  assert.equal(provenance.archiveSha256, 'f84fc8a14e4ff75b9c632f4630982bc77a1a1c9b666f859badd96330def5fbcf');
  for (const [file, hash] of Object.entries(provenance.sha256)) assert.equal(createHash('sha256').update(await readFile(new URL(file, base))).digest('hex'), hash, file);
});
const expected = { ordinary: [17, true, 4], 'old-constraint-counter-evidence': [17, true, 5], 'changed-dependency': [22, true, 6], 'unresolved-risk': [17, false, 4], 'recovery-retry': [17, true, 6] };
for (const [id, [total, success, workCalls]] of Object.entries(expected)) test(`six variants preserve independently checked ${id} work and count every dispatch`, async () => {
  const { benchmarkScenarios, runBenchmarkScenario } = await harness();
  const scenario = benchmarkScenarios().find(item => item.id === id);
  const results = [];
  for (const variant of variants) {
    const result = await runBenchmarkScenario(scenario, variant); results.push(result);
    assert.deepEqual(result.artifacts.invoice, { total, currency: 'USD' });
    assert.equal(result.taskSuccess, true); assert.equal(result.verifiedSuccess, success);
    assert.equal(result.falseCompletionCount, 0); assert.equal(result.workCalls, workCalls);
    assert.deepEqual(result.telemetry, { modelTurns: null, modelTokens: null, modelCacheHits: null, billing: null });
    assert.equal(result.coordinationCalls, result.calls.length);
    assert.equal(result.calls[0].request.method, 'initialize'); assert.equal(result.calls[1].request.method, 'tools/list');
    if (variant === 'v262_fusion') {
      assert.ok(result.calls.every(c => !c.request.params?.arguments?.includeContext && c.request.params?.arguments?.resultLevel !== 'capsule'));
    }
    for (const call of result.calls) {
      assert.equal(call.request.jsonrpc, '2.0'); assert.equal(call.response.jsonrpc, '2.0');
      assert.equal(call.response.id, call.request.id); assert.ok(Object.hasOwn(call.response, 'result') || Object.hasOwn(call.response, 'error'));
      assert.equal(call.requestBytes, wire(call.request)); assert.equal(call.responseBytes, wire(call.response));
      assert.ok(call.elapsedMs >= 0);
    }
    assert.equal(result.requestBytes, result.calls.reduce((n, c) => n + wire(c.request), 0));
    assert.equal(result.responseBytes, result.calls.reduce((n, c) => n + wire(c.response), 0));
    assert.equal(result.combinedBytes, result.requestBytes + result.responseBytes);
    assert.ok(result.contextBytes <= result.responseBytes); assert.ok(result.storageBytes > 0);
    assert.ok(result.calls.some(call => call.category === 'support'));
    if (id === 'old-constraint-counter-evidence') {
      assert.ok(result.expansionCalls > 0);
      assert.deepEqual(result.artifacts.policy, { currency: 'USD', discountAllowed: false });
      assert.equal(result.counterEvidenceResolved, true);
    }
    if (id === 'changed-dependency') assert.ok(result.state.efficiency.evidenceCache.some(item => item.freshness === 'stale'));
    if (id === 'unresolved-risk') assert.deepEqual(result.missingCriteria, ['risk audit']);
    if (id === 'recovery-retry') {
      assert.ok(result.errorCalls > 0); assert.ok(result.retryCalls > 0); assert.ok(result.recoveryCalls > 0);
      if (result.config.fusion) { assert.equal(result.replayCalls, 1); assert.equal(result.conflictCalls, 1); }
    }
    if (result.config.fusion) assert.equal(result.serverReportedCompletion.recommended, success);
    else if (variant.startsWith('v261') || variant === 'v262_legacy') assert.equal(result.serverReportedCompletion, null);
    else assert.equal(result.serverReportedCompletion.recommended, false, 'no explicit criteria silently invented for legacy evaluation');
  }
  for (const result of results) assert.deepEqual(result.workTrace, results[0].workTrace, 'same useful file operations and outputs');
});
test('independent oracle rejects wrong artifact, omitted verification and stale successful evidence', async () => {
  const { benchmarkScenarios, runBenchmarkScenario, verifyBenchmarkArtifacts } = await harness();
  const scenario = benchmarkScenarios()[0]; const result = await runBenchmarkScenario(scenario, variants[5]);
  for (const mutate of [a => { a.invoice.total = 99; }, a => { a.verification = null; }, a => { a.sources['a.json'].quantity = 3; }, a => { a.invoice.currency = 'EUR'; }]) {
    const artifacts = structuredClone(result.artifacts); mutate(artifacts);
    assert.equal(verifyBenchmarkArtifacts(artifacts, scenario).verifiedSuccess, false);
  }
  const omitted = await runBenchmarkScenario({ ...scenario, actions: scenario.actions.filter(a => a.type !== 'verify') }, variants[5]);
  assert.equal(omitted.verifiedSuccess, false); assert.equal(omitted.falseCompletionCount, 0);
});
test('model evaluation dataset remains explicitly unrun with independent quality rubric', async () => {
  assert.ok(existsSync(new URL('../docs/model-evaluation-v262.json', import.meta.url)), 'machine-readable model protocol exists');
  const dataset = JSON.parse(await readFile(new URL('../docs/model-evaluation-v262.json', import.meta.url), 'utf8'));
  assert.equal(dataset.status, 'not_run'); assert.deepEqual(dataset.variants, variants);
  assert.equal(dataset.cases.length, 5); assert.equal(dataset.results, null);
  for (const dimension of ['constraint_preservation', 'tool_evidence_use', 'recovery', 'premature_completion']) assert.ok(dataset.rubric[dimension]);
});
test('benchmark report retains every repeated trace and reconciles first-sample totals', async () => {
  const { runBenchmark } = await harness();
  await assert.rejects(runBenchmark({ repetitions: 1 }), /three/);
  const report = await runBenchmark();
  assert.equal(report.modelEvaluation.status, 'not_run');
  assert.equal(report.comparisons.length, 5);
  for (const comparison of report.comparisons) {
    assert.equal(comparison.qualityRegression, false);
    assert.deepEqual(comparison.results.map(r => r.variant), variants);
    for (const result of comparison.results) {
      assert.equal(result.repetitions.length, 3);
      assert.deepEqual(result.latency.samplesMs, result.repetitions.map(r => r.elapsedMs));
      assert.equal(result.latency.maxMs, Math.max(...result.latency.samplesMs));
      assert.ok(result.repetitions.every(r => r.calls.length === r.coordinationCalls && r.falseCompletionCount === 0));
    }
  }
  for (const total of report.totals) {
    const runs = report.comparisons.map(c => c.results.find(r => r.variant === total.variant));
    assert.equal(total.verifiedSuccessCount, 4); assert.equal(total.taskSuccessCount, 5);
    for (const field of ['workCalls', 'coordinationCalls', 'requestBytes', 'responseBytes', 'combinedBytes', 'storageBytes']) {
      assert.equal(total[field], runs.reduce((n, r) => n + r[field], 0));
    }
  }
});

test('latency summary computes conventional even medians and describes the actual sample count', async () => {
  const { summarizeLatency, describeTiming } = await harness();
  assert.equal(typeof summarizeLatency, 'function');
  assert.deepEqual(summarizeLatency([4, 1, 3, 2]), { samplesMs: [4, 1, 3, 2], medianMs: 2.5, maxMs: 4 });
  assert.equal(summarizeLatency([3, 1, 2]).medianMs, 2);
  assert.match(describeTiming(4), /4 isolated-store workers/);
  assert.match(describeTiming(4), /Median and maximum of 4/);
});
