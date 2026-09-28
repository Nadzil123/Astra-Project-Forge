import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchmarkScenarios, runBenchmarkScenario } from '../scripts/benchmark-v261.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = new URL('./fixtures/v261-verified/', import.meta.url);
const commit = 'cd0edae9921c80784e11ce3bcaec57f29c224786';
// Independently read from immutable git objects before generating the fixture.
const hashes = {
  'ATTRIBUTION.md': '74a9857795d90cd3368a73331192f712cc9412d95314eee18ce95486781501a4',
  LICENSE: '5132c7f0475b02c8107a2e0f0363e70423c62d2664ab927e76193226e5e05905',
  'NOTICE.md': 'c35cd5c397efd7eb5313a46f8bce86065f92745d1e080fba134e537e4bcfe598',
  'package.json': '8411815d2d11df6dd22fa140c8a66afde0b7185ec54fe52b58f08b018ef15c70',
  'server/adaptive-router.mjs': '4e0d6024cd196601c38e36396173a76f625e5cfc5921b7e486991012457b0506',
  'server/agent-state.mjs': 'ebd558fbba290ae12063fc469831475199a320fe052a3f5504f7c133d2885869',
  'server/context-efficiency.mjs': '5a5ffb92fe64c73ce095d57ac230d0e8c4bbfc99a39fbfdbb6139131c4734f44',
  'server/efficiency-governor.mjs': '2f296c69cac192b7ee4fe30b479ec57ad0267c23527e810b702f84529b7ab147',
  'server/efficiency-ledger.mjs': 'd86cbab5af9fc480c6e4ad647f9af12060083c57174c517f0daadde6eec532a0',
  'server/evidence-cache.mjs': 'e208520b0b561fb34e31ddbb7060229e0b4ff1e03473f0351c857f127a70f0a5',
  'server/mcp-server.mjs': 'bee6b1aff591a64cf42dafe29034d4b6e8430efa2fb38377c1d749cd3c037ea0',
  'server/state-store.mjs': '9ddb4e09dd48890e91dc2f9fffcb5592914c51c3baf162c65c72261176ba205a',
};
const versions = ['v260_baseline', 'v261_verified', 'v261_compact'];
const controls = ['forge_route', 'forge_plan', 'forge_observe', 'forge_evaluate'];
const wireBytes = value => Buffer.byteLength(JSON.stringify(value));
const sum = (items, field) => items.reduce((total, item) => total + item[field], 0);
const nullTelemetry = { modelTurns: null, modelTokens: null, modelCacheHits: null, billing: null };

// Compare decisions and references across isolated stores, ignoring only random
// UUIDs and wall-clock timestamps; retain dependency/artifact hashes and revisions.
const stable = value => JSON.parse(JSON.stringify(value)
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<time>'));

function run(command, args, cwd = root, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

async function verifyFixture(directory) {
  assert.ok(existsSync(directory), 'Immutable verified v2.6.1 fixture must exist');
  const provenance = JSON.parse(await readFile(new URL('provenance.json', directory), 'utf8'));
  assert.equal(provenance.commit, commit);
  assert.equal(provenance.sourcePath, 'plugins/astra-project-forge');
  assert.deepEqual(provenance.sha256, hashes);
  assert.deepEqual((await readdir(new URL('server/', directory))).sort(),
    Object.keys(hashes).filter(name => name.startsWith('server/')).map(name => name.slice(7)).sort());
  for (const [file, expected] of Object.entries(hashes)) {
    const content = await readFile(new URL(file, directory));
    assert.equal(createHash('sha256').update(content).digest('hex'), expected, file);
    if (['LICENSE', 'NOTICE.md', 'ATTRIBUTION.md'].includes(file)) {
      assert.deepEqual(content, await readFile(new URL(`./fixtures/v260-baseline/${file}`, import.meta.url)), file);
    }
  }
}

test('verified baseline freezes exact immutable runtime, metadata and legal bytes', async () => {
  await verifyFixture(fixture);
});

const cases = {
  'duplicate-heavy': { cycles: 4, reusedEvidence: 2, retries: 0, success: true },
  'useful-over-budget': { cycles: 7, reusedEvidence: 0, retries: 0, success: true },
  'changed-dependency': { cycles: 6, reusedEvidence: 0, retries: 0, success: true },
  'unresolved-risk': { cycles: 4, reusedEvidence: 0, retries: 0, success: false },
  'unchanged-retry': { cycles: 6, reusedEvidence: 0, retries: 1, success: true },
  'context-resume': { cycles: 4, reusedEvidence: 0, retries: 0, success: true },
};

for (const [id, expected] of Object.entries(cases)) {
  test(`three-way ${id}: same quality, useful work, controls and real wire accounting`, async () => {
    const scenario = benchmarkScenarios().find(item => item.id === id);
    const results = [];
    for (const version of versions) results.push(await runBenchmarkScenario(scenario, version));
    const [baseline, verified, compact] = results;
    for (const result of results) {
      assert.equal(result.verifiedSuccess, expected.success);
      assert.deepEqual(result.artifact, scenario.expected);
      assert.equal(result.taskSuccess, true);
      assert.equal(result.verifications.at(-1).passed, true);
      assert.deepEqual(result.missingCriteria, expected.success ? [] : ['risk audit']);
      assert.equal(result.stopReason, expected.success ? 'verified_success' : 'workload_exhausted');
      assert.equal(result.trace.some(item => item.target === 'unneeded.json'), false);
      assert.deepEqual(result.telemetry, nullTelemetry);
      assert.equal(result.coordinationToolCalls, result.calls.length);
      for (const call of result.calls) {
        assert.equal(call.requestBytes, wireBytes(call.request));
        assert.equal(call.responseBytes, wireBytes(call.response));
      }
      assert.equal(result.coordinationRequestBytes, sum(result.calls, 'requestBytes'));
      assert.equal(result.coordinationResponseBytes, sum(result.calls, 'responseBytes'));
      assert.equal(result.coordinationCombinedBytes, result.coordinationRequestBytes + result.coordinationResponseBytes);
      assert.ok(result.contextBytes <= result.coordinationResponseBytes);
      for (const field of ['elapsedMs', 'workMs', 'coordinationMs', 'harnessMs', 'otherMs']) {
        assert.ok(Number.isFinite(result[field]) && result[field] >= 0, field);
      }
    }
    assert.ok(!baseline.verifiedSuccess || compact.verifiedSuccess);
    for (const result of [verified, compact]) {
      assert.equal(result.cycles, expected.cycles);
      assert.equal(result.reusedEvidence, expected.reusedEvidence);
      assert.equal(result.retries, expected.retries);
      assert.equal(result.duplicateToolCalls, 0);
      assert.equal(result.ledger.reusedEvidence, expected.reusedEvidence);
    }
    for (const field of ['cycles', 'toolCalls', 'usefulActions', 'contextUnits', 'contextBytes',
      'coordinationToolCalls', 'totalToolCalls', 'harnessOperations', 'totalOperations', 'softBudget',
      'verifications', 'ledger', 'evidenceCache', 'failedStrategies']) {
      assert.deepEqual(stable(compact[field]), stable(verified[field]), `${id}/${field}`);
    }
    const decisionTrace = result => stable(result.trace.map(({ plan, ...item }) => ({ ...item,
      ...(plan ? { plan: Object.fromEntries(Object.entries(plan).filter(([key]) =>
        !['action', 'why', 'expectedEvidence', 'createdAt'].includes(key))) } : {}),
    })));
    assert.deepEqual(decisionTrace(compact), decisionTrace(verified));
    assert.deepEqual(compact.calls.map(call => [call.name, call.isError]), verified.calls.map(call => [call.name, call.isError]));
    let optionBytes = 0;
    for (let index = 0; index < compact.calls.length; index++) {
      const actual = compact.calls[index];
      const original = verified.calls[index];
      const request = structuredClone(actual.request);
      if (controls.includes(actual.name)) {
        assert.equal(request.params.arguments.resultLevel, 'summary');
        assert.equal(Object.hasOwn(original.request.params.arguments, 'resultLevel'), false);
        delete request.params.arguments.resultLevel;
        optionBytes += actual.requestBytes - wireBytes(request);
      }
      assert.deepEqual(stable(request), stable(original.request));
      assert.equal(actual.requestBytes - original.requestBytes, controls.includes(actual.name) ? 24 : 0);
      // Non-control responses and rejected-plan errors must remain unchanged.
      if (!controls.includes(actual.name) || actual.isError) {
        assert.deepEqual(stable(actual.response), stable(original.response));
      }
    }
    assert.equal(compact.coordinationRequestBytes, verified.coordinationRequestBytes + optionBytes);
    assert.ok(optionBytes > 0);
    assert.ok(compact.coordinationResponseBytes < verified.coordinationResponseBytes);
    assert.ok(compact.coordinationCombinedBytes < verified.coordinationCombinedBytes);
    for (const result of [verified, compact]) {
      const evaluations = result.calls.filter(call => call.name === 'forge_evaluate');
      for (const call of evaluations) {
        const args = call.request.params.arguments;
        assert.ok(result.calls.some(item => item.name === 'forge_plan' && item.response.structuredContent?.plan?.id === args.planId));
        assert.ok(result.calls.some(item => item.name === 'forge_observe' && item.response.structuredContent?.observation?.id === args.evidenceIds[0]));
        assert.deepEqual(call.response.structuredContent.evaluation.missingCriteria, args.missingCriteria);
      }
      if (id === 'duplicate-heavy') {
        const reused = result.calls.filter(call => call.name === 'forge_route' && call.response.structuredContent?.evidenceRecord);
        assert.equal(reused.length, 2);
        assert.deepEqual(reused.map(call => call.response.structuredContent.evidenceRecord.result),
          [{ quantity: 2, unitPrice: 5 }, { quantity: 2, unitPrice: 5 }]);
      }
      if (id === 'changed-dependency') {
        assert.ok(result.evidenceCache.some(record => record.target === 'a.json' && record.freshness === 'stale'));
        assert.equal(result.calls.filter(call => call.name === 'forge_adapt').length, 1);
      }
      if (id === 'useful-over-budget') {
        assert.equal(result.softBudget, 2);
        assert.ok(result.cycles > result.softBudget);
        const overrides = result.trace.filter(item => item.plan?.budgetOverride);
        assert.ok(overrides.length > 0);
        assert.equal(result.ledger.softBudgetOverrides, overrides.length);
        assert.ok(overrides.every(item => item.plan.budgetOverride.justification.length > 30));
        assert.ok(result.trace.some(item => item.type === 'audit' && item.result.passed));
      }
      if (id === 'unchanged-retry') {
        assert.equal(result.failedStrategies.length, 1);
        assert.equal(result.trace.filter(item => item.status === 'rejected').length, 1);
        assert.match(result.trace.find(item => item.status === 'rejected').error, /Failed strategy cannot be repeated unchanged/);
      }
    }
  });
}

test('new v261 modes cannot certify wrong artifacts or omitted verification', async () => {
  const scenario = benchmarkScenarios()[0];
  for (const version of ['v261_verified', 'v261_compact']) {
    const wrong = await runBenchmarkScenario({ ...scenario, expected: { total: 999 } }, version);
    assert.equal(wrong.taskSuccess, false);
    assert.equal(wrong.verifiedSuccess, false);
    const unverified = await runBenchmarkScenario({ ...scenario,
      actions: scenario.actions.filter(action => !['verify'].includes(action.type) && action.target !== 'unneeded.json') }, version);
    assert.equal(unverified.taskSuccess, true);
    assert.equal(unverified.verifiedSuccess, false);
    assert.ok(unverified.missingCriteria.includes('artifact verification'));
  }
});

test('legacy v261_efficiency keeps current full control responses', async () => {
  const result = await runBenchmarkScenario(benchmarkScenarios()[0], 'v261_efficiency');
  assert.equal(result.verifiedSuccess, true);
  for (const call of result.calls.filter(item => controls.includes(item.name))) {
    assert.ok(call.request, 'Call records must expose the actual serialized request');
    assert.equal(Object.hasOwn(call.request.params.arguments, 'resultLevel'), false);
  }
  assert.ok(result.calls.find(call => call.name === 'forge_route').response.structuredContent.route.cycleBudget);
  assert.equal(typeof result.trace[0].plan.action, 'string');
});

test('CLI reports three versions, additive totals and explicit pairwise byte/count/time deltas', () => {
  const report = JSON.parse(run(process.execPath, ['scripts/benchmark-v261.mjs']));
  assert.equal(report.verifiedBaselineCommit, commit);
  assert.deepEqual(report.comparisons.map(item => item.scenario), Object.keys(cases));
  const fields = ['cycles', 'toolCalls', 'duplicateToolCalls', 'usefulActions', 'reusedEvidence', 'retries',
    'coordinationToolCalls', 'harnessOperations', 'totalToolCalls', 'totalOperations', 'contextBytes', 'contextUnits',
    'coordinationRequestBytes', 'coordinationResponseBytes', 'coordinationCombinedBytes',
    'elapsedMs', 'workMs', 'coordinationMs', 'harnessMs', 'otherMs'];
  for (const group of [...report.comparisons, { results: report.totals, deltas: report.deltas }]) {
    assert.deepEqual(group.results.map(item => item.version), versions);
    for (const [from, to] of [[0, 1], [0, 2], [1, 2]]) {
      for (const field of fields) {
        assert.equal(group.deltas[`${versions[to]}_vs_${versions[from]}`][field], group.results[to][field] - group.results[from][field]);
      }
    }
  }
  for (const total of report.totals) {
    const runs = report.comparisons.map(item => item.results.find(result => result.version === total.version));
    assert.equal(total.scenarioCount, 6);
    assert.equal(total.verifiedSuccessCount, 5);
    assert.equal(total.taskSuccessCount, 6);
    assert.deepEqual(total.telemetry, nullTelemetry);
    for (const field of fields) assert.equal(total[field], sum(runs, field));
  }
  assert.ok(report.comparisons.every(item => item.qualityRegression === false));
});

test('both release ZIPs contain immutable runnable baselines without git or live production imports', async () => {
  assert.ok(existsSync(fixture), 'Verified fixture is required in standalone archives');
  const directory = await mkdtemp(path.join(tmpdir(), 'forge-verified-zip-'));
  try {
    const packaged = JSON.parse(run(process.execPath, ['scripts/package-release.mjs', '--output-dir', path.join(directory, 'archives')]));
    for (const [index, archive] of packaged.archives.entries()) {
      const extraction = path.join(directory, `extract-${index}`);
      run('unzip', ['-q', archive.archive, '-d', extraction]);
      const plugin = path.join(extraction, archive.pluginPath);
      const { pathToFileURL } = await import('node:url');
      await verifyFixture(pathToFileURL(path.join(plugin, 'tests/fixtures/v261-verified/')));
      // Deliberately remove current production: a mislabeled live baseline must fail.
      await rm(path.join(plugin, 'server'), { recursive: true });
      const output = run(process.execPath, ['-e', `(async () => {
        const { dispatch } = await import('./tests/fixtures/v261-verified/server/mcp-server.mjs');
        const { tools } = await dispatch({ method: 'tools/list' });
        if (tools.length !== 19) throw new Error('Missing frozen tools');
        const { benchmarkScenarios, runBenchmarkScenario } = await import('./scripts/benchmark-v261.mjs');
        const results = [];
        for (const scenario of benchmarkScenarios()) results.push(await runBenchmarkScenario(scenario, 'v261_verified'));
        console.log(JSON.stringify(results.map(({ artifact, verifiedSuccess }) => ({ artifact, verifiedSuccess }))));
      })().catch(error => { console.error(error); process.exitCode = 1; });`], plugin, { ...process.env, PATH: path.join(directory, 'no-executables'),
        ASTRA_PROJECT_FORGE_DATA_DIR: path.join(directory, `state-${index}`) });
      assert.deepEqual(JSON.parse(output), benchmarkScenarios().map(scenario => ({
        artifact: scenario.expected, verifiedSuccess: scenario.id !== 'unresolved-risk',
      })));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
