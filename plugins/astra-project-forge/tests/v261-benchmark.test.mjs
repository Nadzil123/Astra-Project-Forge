import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { routeTask } from '../server/adaptive-router.mjs';

const script = new URL('../scripts/benchmark-v261.mjs', import.meta.url);
async function harness() {
  assert.ok(existsSync(script), 'The runnable real-production benchmark must exist');
  return import(script.href);
}
async function run(id, version = 'v261_efficiency', change = {}) {
  const { benchmarkScenarios, runBenchmarkScenario } = await harness();
  const scenario = benchmarkScenarios().find(item => item.id === id);
  assert.ok(scenario, `Missing workload: ${id}`);
  return runBenchmarkScenario({ ...scenario, ...change }, version);
}

test('efficiency preserves independently verified success on every workload', async () => {
  const { benchmarkScenarios, runBenchmarkScenario } = await harness();
  const scenarios = benchmarkScenarios();
  assert.equal(scenarios.length, 6);
  for (const scenario of scenarios) {
    const baseline = await runBenchmarkScenario(scenario, 'v260_baseline');
    const efficient = await runBenchmarkScenario(scenario, 'v261_efficiency');
    assert.ok(!baseline.verifiedSuccess || efficient.verifiedSuccess, scenario.id);
    assert.equal(efficient.verifiedSuccess, scenario.id !== 'unresolved-risk', scenario.id);
    assert.deepEqual(efficient.artifact, scenario.expected, scenario.id);
    assert.deepEqual(baseline.artifact, scenario.expected, scenario.id);
  }
});

test('duplicate-heavy work reuses actual stored evidence and reduces executed calls', async () => {
  const baseline = await run('duplicate-heavy', 'v260_baseline');
  const efficient = await run('duplicate-heavy');
  assert.ok(efficient.toolCalls < baseline.toolCalls);
  assert.equal(baseline.duplicateToolCalls, 2);
  assert.equal(efficient.duplicateToolCalls, 0);
  assert.equal(efficient.reusedEvidence, 2);
  assert.equal(efficient.ledger.reusedEvidence, 2);
  assert.equal(baseline.reusedEvidence, 0);
  assert.deepEqual(efficient.trace.filter(item => item.status === 'reused').map(item => item.result),
    [{ quantity: 2, unitPrice: 5 }, { quantity: 2, unitPrice: 5 }]);
});

test('both versions retain necessary cycles beyond their actual routing budgets', async () => {
  const efficient = await run('useful-over-budget');
  const baseline = await run('useful-over-budget', 'v260_baseline');
  assert.equal(efficient.softBudget, 2);
  assert.equal(baseline.softBudget, 6);
  for (const result of [efficient, baseline]) {
    assert.equal(result.verifiedSuccess, true);
    assert.equal(result.cycles, 7);
    assert.ok(result.cycles > result.softBudget);
    assert.equal(result.toolCalls, 7);
  }
  const overrides = efficient.trace.filter(item => item.plan?.budgetOverride);
  assert.ok(overrides.length > 0);
  assert.equal(efficient.ledger.softBudgetOverrides, overrides.length);
  assert.ok(overrides.every(item => item.plan.budgetOverride.justification.length > 30));
});

test('changed dependencies invalidate prior evidence and produce the updated artifact', async () => {
  const result = await run('changed-dependency');
  assert.equal(result.verifiedSuccess, true);
  assert.deepEqual(result.trace.filter(item => item.type === 'read').map(item => item.result),
    [{ quantity: 2, unitPrice: 5 }, { quantity: 3, unitPrice: 5 }, { quantity: 1, unitPrice: 7 }]);
  assert.equal(result.reusedEvidence, 0);
  assert.ok(result.evidenceCache.some(item => item.target === 'a.json' && item.freshness === 'stale'));
  assert.deepEqual(result.artifact, { total: 22 });
});

test('passing functional evidence cannot conceal unresolved risk', async () => {
  const result = await run('unresolved-risk');
  assert.equal(result.taskSuccess, true);
  assert.equal(result.verifications.at(-1).passed, true);
  assert.equal(result.verifiedSuccess, false);
  assert.deepEqual(result.missingCriteria, ['risk audit']);
  assert.notEqual(result.stopReason, 'verified_success');
});

test('the actual plan guard rejects unchanged failure but permits changed conditions', async () => {
  const efficient = await run('unchanged-retry');
  const baseline = await run('unchanged-retry', 'v260_baseline');
  assert.equal(efficient.verifiedSuccess, true);
  assert.equal(efficient.retries, 1);
  assert.equal(baseline.retries, 2);
  const rejected = efficient.trace.filter(item => item.status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].error, /Failed strategy cannot be repeated unchanged/);
  assert.equal(efficient.failedStrategies.length, 1);
  assert.equal(efficient.duplicateToolCalls, 0);
  assert.equal(baseline.duplicateToolCalls, 1);
});

test('quality depends on the expected artifact and executed verification, not completion flags', async () => {
  const wrongExpectation = await run('duplicate-heavy', 'v261_efficiency', { expected: { total: 999 } });
  assert.equal(wrongExpectation.taskSuccess, false);
  assert.equal(wrongExpectation.verifiedSuccess, false);
  const { benchmarkScenarios } = await harness();
  const scenario = benchmarkScenarios().find(item => item.id === 'duplicate-heavy');
  const unverified = await run(scenario.id, 'v261_efficiency', {
    actions: scenario.actions.filter(action => action.type !== 'verify').map(action => ({ ...action, completes: true })),
  });
  assert.equal(unverified.taskSuccess, true);
  assert.equal(unverified.verifiedSuccess, false);
  assert.ok(unverified.missingCriteria.includes('artifact verification'));
});

test('completion prevents queued extra work immediately in both versions', async () => {
  for (const version of ['v260_baseline', 'v261_efficiency']) {
    const result = await run('duplicate-heavy', version);
    assert.equal(result.stopReason, 'verified_success');
    assert.equal(result.trace.at(-1).type, 'verify');
    assert.equal(result.trace.some(item => item.target === 'unneeded.json'), false);
    if (version === 'v261_efficiency') assert.equal(result.finalRoute.efficiencyDecision, 'stop');
  }
});

function leaves(value) {
  return value !== null && typeof value === 'object'
    ? Object.values(value).reduce((sum, child) => sum + leaves(child), 0) : 1;
}

test('context metrics count delivered JSON and baseline uses bounded summary and working retrieval', async () => {
  for (const version of ['v260_baseline', 'v261_efficiency']) {
    const result = await run('context-resume', version);
    assert.ok(result.contexts.some(item => item.request.detail === 'summary'));
    assert.ok(result.contexts.some(item => item.request.detail === 'working'));
    assert.ok(result.contexts.every(item => item.request.detail !== 'full'));
    assert.equal(result.contextBytes, result.contexts.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item.context)), 0));
    assert.equal(result.contextUnits, result.contexts.reduce((sum, item) => sum + leaves(item.context), 0));
    if (version === 'v261_efficiency') {
      assert.ok(result.contexts.some(item => Number.isInteger(item.request.sinceRevision)));
    } else {
      assert.ok(result.contexts.every(item => item.request.maxItems === 3));
    }
  }
});

test('accounting includes coordination, harness work and unavailable host telemetry', async () => {
  const result = await run('unchanged-retry');
  assert.equal(result.toolCalls, result.trace.filter(item => item.status === 'executed').length);
  assert.equal(result.coordinationToolCalls, result.calls.length);
  assert.equal(result.totalToolCalls, result.toolCalls + result.coordinationToolCalls);
  assert.equal(result.totalOperations, result.totalToolCalls + result.harnessOperations);
  assert.ok(result.harnessOperations > 0);
  assert.ok(result.calls.some(item => item.isError));
  assert.ok(result.calls.every(item => item.requestBytes > 0 && item.responseBytes > 0));
  for (const field of ['elapsedMs', 'workMs', 'coordinationMs', 'harnessMs']) {
    assert.ok(Number.isFinite(result[field]) && result[field] >= 0, field);
  }
  assert.ok(result.elapsedMs >= result.workMs + result.coordinationMs + result.harnessMs);
  assert.deepEqual(result.telemetry, { modelTurns: null, modelTokens: null, modelCacheHits: null, billing: null });
});

test('decisions and operation counts remain deterministic across isolated runs', async () => {
  const first = await run('unchanged-retry');
  const second = await run('unchanged-retry');
  for (const field of ['verifiedSuccess', 'cycles', 'toolCalls', 'duplicateToolCalls', 'usefulActions',
    'contextUnits', 'contextBytes', 'reusedEvidence', 'retries', 'coordinationToolCalls', 'totalToolCalls',
    'harnessOperations', 'totalOperations', 'stopReason']) assert.equal(first[field], second[field], field);
  assert.deepEqual(first.trace.map(item => item.status), second.trace.map(item => item.status));
});

test('frozen release source and license bytes match the controller provenance', async () => {
  const files = {
    'server/state-store.mjs': '3f4143ceb52074ae8c40ad044310f7fe3dd2ea3c73d32c6eacb951c11233082c',
    'server/agent-state.mjs': '056479e9afe9088ff6c9540252c51af2e87068089756adf7e38cff100b47d33f',
    'server/adaptive-router.mjs': '4bc7b5cc669c05121fbeba7e8f58174450c9203d5a044b54998606aeed9bc6c6',
    'server/mcp-server.mjs': 'e2509f124441ef317dcde139979c139eaa3ee00c15a810d5af69746abae08862',
    LICENSE: '5132c7f0475b02c8107a2e0f0363e70423c62d2664ab927e76193226e5e05905',
    'NOTICE.md': 'c35cd5c397efd7eb5313a46f8bce86065f92745d1e080fba134e537e4bcfe598',
    'ATTRIBUTION.md': '74a9857795d90cd3368a73331192f712cc9412d95314eee18ce95486781501a4',
  };
  for (const [file, expected] of Object.entries(files)) {
    const url = new URL(`./fixtures/v260-baseline/${file}`, import.meta.url);
    assert.ok(existsSync(url), `Missing frozen fixture: ${file}`);
    assert.equal(createHash('sha256').update(await readFile(url)).digest('hex'), expected, file);
  }
});

test('all legacy router fields match the immutable v260 router across profiles and policies', async () => {
  const baselineUrl = new URL('./fixtures/v260-baseline/server/adaptive-router.mjs', import.meta.url);
  assert.ok(existsSync(baselineUrl), 'Immutable v260 router is required for compatibility comparison');
  const { routeTask: baselineRoute } = await import(baselineUrl.href);
  const inputs = [
    { complexity: 'simple', uncertainty: 'low' },
    { complexity: 'moderate', uncertainty: 'low', verificationNeeded: false, multiStep: false },
    {},
    { complexity: 'complex', uncertainty: 'high', continuityNeeded: true },
    { complexity: 'complex', uncertainty: 'high', risk: 'high', expectedIterations: 8,
      capabilityNeeds: ['testing', 'repository', 'testing', 'docs', 'runtime', 'review'], repeatedFailure: true },
  ];
  for (const [efficiencyPolicy, budgets] of [
    ['eco', [0, 1, 1, 2, 2]], ['balanced', [0, 1, 3, 3, 3]],
    ['performance', [0, 1, 3, 5, 5]], ['maximum', [0, 1, 4, 6, 6]],
  ]) {
    for (const [index, input] of inputs.entries()) {
      const baseline = baselineRoute(input);
      const current = routeTask({ ...input, efficiencyPolicy });
      for (const [key, value] of Object.entries(baseline)) {
        if (key !== 'cycleBudget') assert.deepEqual(current[key], value, `${efficiencyPolicy}/${index}/${key}`);
      }
      assert.equal(current.cycleBudget, budgets[index]);
      assert.equal(current.softCycleBudget, current.cycleBudget);
    }
  }
});
