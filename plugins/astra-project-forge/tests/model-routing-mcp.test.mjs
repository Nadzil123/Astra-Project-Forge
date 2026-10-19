import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectStore } from '../server/state-store.mjs';
import { getStateIdentity } from '../server/coordination-core.mjs';
import { routingFixture, supportAllCriteria } from './helpers/model-routing-fixtures.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = path.join(root, 'server/mcp-server.mjs');
const baseline = path.join(root, 'tests/fixtures/v262-routing-baseline/server/mcp-server.mjs');
const moduleURL = new URL('../server/mcp-server.mjs', import.meta.url).href;
const names = ['forge_route', 'forge_goal', 'forge_context', 'forge_observe', 'forge_plan',
  'forge_evaluate', 'forge_adapt', 'forge_checkpoint', 'forge_consolidate', 'adaptive_route_task',
  'adaptive_get_context', 'adaptive_initialize_project', 'adaptive_get_state', 'adaptive_list_projects',
  'adaptive_record_observation', 'adaptive_record_hypothesis', 'adaptive_record_experiment',
  'adaptive_checkpoint', 'adaptive_consolidate'];
const request = patch => ({ version: 1, workUnitId: 'work-1', sourceIdentity: 'source:v1',
  currentModel: 'gpt-6.1-sol', userPreference: 'auto', forbiddenModels: [], benefit: null,
  nextHypothesis: null, stableBoundary: false, receiverCanResolveReferences: true, ...patch });
const optimistic = { successCriteriaSatisfied: true, evidenceSufficient: true,
  contradictionRemaining: false, meaningfulRiskRemaining: false };

async function sandbox(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'forge-routing-mcp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function environment(dir, mode, extra = {}) {
  const env = { ...process.env, ASTRA_PROJECT_FORGE_DATA_DIR: dir, ...extra };
  // Tests never inherit operator model permissions or routing configuration.
  for (const key of ['ASTRA_REQUIRED_MODEL', 'ASTRA_ALLOWED_MODELS', 'ASTRA_FORGE_MODEL_ROUTING']) delete env[key];
  return { ...env, ...(mode === undefined ? {} : { ASTRA_FORGE_MODEL_ROUTING: mode }), ...extra };
}
async function client(t, { dir, mode = 'off', entry = server, extra } = {}) {
  dir ??= await sandbox(t);
  const child = spawn(process.execPath, [entry, '--stdio'], {
    cwd: root, env: environment(dir, mode, extra), stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '', stderr = '', id = 0;
  const pending = new Map();
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const reply = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      const entry = pending.get(reply.id);
      if (entry) {
        pending.delete(reply.id);
        clearTimeout(entry.timer);
        if (reply.error) entry.reject(new Error(reply.error.message));
        else entry.resolve(reply.result);
      }
    }
  });
  child.on('exit', code => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`MCP exited ${code}: ${stderr}`));
    }
    pending.clear();
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    assert.equal(stderr, '');
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const next = ++id;
    const timer = setTimeout(() => { pending.delete(next); reject(new Error(`MCP timeout: ${method}`)); }, 5000);
    pending.set(next, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: next, method, params })}\n`);
  });
  return { dir, rpc, call: (name, args = {}) => rpc('tools/call', { name, arguments: args }) };
}
async function project(t, options = {}) {
  const c = await client(t, { mode: 'advisory-v1', ...options });
  await c.call('adaptive_initialize_project', { projectId: 'p', goal: 'Verify routing',
    successCriteria: ['mandatory check'], constraints: ['Keep recovery reachable'] });
  const state = (await c.call('adaptive_get_state', { projectId: 'p' })).structuredContent.project;
  const target = path.join(c.dir, (await readdir(c.dir)).find(name => name.endsWith('.json')));
  return { ...c, state, target, args: { projectId: 'p', complexity: 'simple',
    modelRouting: request({ operationId: 'route-1', expectedState: getStateIdentity(state) }) } };
}
function adviceLimits(advice) {
  assert.equal(advice.version, 1);
  assert.equal(advice.advisory, true);
  assert.equal(advice.verificationPreserved, true);
  assert.equal(advice.executionStatus, 'not_attempted');
  assert.equal(advice.observedModel, null);
  assert.equal(advice.remainingVerifiedCost, null);
  assert.equal(advice.calibration, 'not_measured');
  assert.ok(advice.unmetCriteria.length > 0);
}

test('legacy calls are unchanged with routing omitted', async t => {
  const old = await client(t, { entry: baseline });
  const off = await client(t);
  const on = await client(t, { mode: 'advisory-v1' });
  assert.deepEqual(await off.rpc('initialize'), await old.rpc('initialize'));
  assert.deepEqual(await off.rpc('tools/list'), await old.rpc('tools/list'));
  for (const tool of ['forge_route', 'adaptive_route_task']) {
    for (const args of [{ complexity: 'simple' }, { complexity: 'complex', ...optimistic }]) {
      const expected = await old.call(tool, args);
      assert.deepEqual(await off.call(tool, args), expected);
      assert.deepEqual(await on.call(tool, args), expected);
    }
  }
  const p = await project(t);
  const before = (await p.call('adaptive_get_state', { projectId: 'p' })).structuredContent.project;
  const result = await p.call('forge_route', { projectId: 'p', complexity: 'simple' });
  assert.deepEqual(Object.keys(result.structuredContent).sort(), ['deepNoticeRequired', 'noticeRequired', 'route']);
  const after = (await p.call('adaptive_get_state', { projectId: 'p' })).structuredContent.project;
  assert.equal(after.revision, before.revision + 1);
  assert.equal(Object.hasOwn(after, 'modelRouting'), false);
});

test('advisory negotiation adds no tool or required input and preserves the old catalog', async t => {
  const off = await client(t);
  const on = await client(t, { mode: 'advisory-v1' });
  const legacyInit = await off.rpc('initialize');
  const init = await on.rpc('initialize');
  assert.deepEqual(init, { ...legacyInit, capabilities: { tools: { listChanged: false },
    experimental: { modelRouting: { version: 1, mode: 'advisory-v1' } } } });
  const catalog = await on.rpc('tools/list');
  assert.deepEqual(catalog.tools.map(tool => tool.name), names);
  const route = catalog.tools.find(tool => tool.name === 'forge_route');
  assert.deepEqual(route.inputSchema.required, ['complexity']);
  const schema = route.inputSchema.properties.modelRouting;
  assert.equal(schema?.properties.version.const, 1);
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.required.includes('receiverCanResolveReferences'));
  delete route.inputSchema.properties.modelRouting;
  assert.deepEqual(catalog, await off.rpc('tools/list'));
  const mod = await import('../server/model-routing-schema.mjs');
  const canonical = await import('../server/model-router.mjs');
  assert.strictEqual(mod.validateModelRoutingRequest, canonical.validateModelRoutingRequest);
  assert.deepEqual(mod.modelRoutingSchemaV1, schema);
});

test('older server fallback omits unsupported metadata without a retry loop', async t => {
  for (const options of [{ entry: baseline }, { mode: 'off' }, { mode: 'advisory-v1' }]) {
    const c = await client(t, options);
    const init = await c.rpc('initialize');
    const catalog = await c.rpc('tools/list');
    const negotiated = init.capabilities.experimental?.modelRouting?.version === 1
      && catalog.tools.find(tool => tool.name === 'forge_route').inputSchema.properties.modelRouting;
    const result = await c.call('forge_route', { complexity: 'simple', ...(negotiated ? { modelRouting: request() } : {}) });
    assert.equal(result.isError, undefined);
    assert.equal(Object.hasOwn(result.structuredContent, 'modelAdvice'), Boolean(negotiated));
  }
});

test('disabled explicit metadata errors before generic validation or writes', async t => {
  const p = await project(t, { mode: 'off' });
  const before = await readFile(p.target);
  for (const modelRouting of [null, [], { version: 2 }, p.args.modelRouting]) {
    const result = await p.call('forge_route', { ...p.args, modelRouting, resultLevel: 'invalid' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /model routing.*disabled/i);
    assert.deepEqual(await readFile(p.target), before);
  }
});

test('bad envelope cannot mutate state or accept caller authority', async t => {
  const p = await project(t);
  const before = await readFile(p.target);
  const bad = [null, [], { ...p.args.modelRouting, version: 2 },
    { ...p.args.modelRouting, userPreference: 'fast' }, { ...p.args.modelRouting, stableBoundary: 'yes' },
    { ...p.args.modelRouting, expectedState: { ...p.args.modelRouting.expectedState, revision: Number.MAX_SAFE_INTEGER + 1 } },
    ...['runtime', 'eligibility', 'observedModel', 'hostCapabilities', '__proto__'].map(key =>
      JSON.parse(JSON.stringify(p.args.modelRouting).replace(/}$/, `,"${key}":{}}`))),
    { ...p.args.modelRouting, benefit: { kind: 'dependency_risk', reason: 'inspect', refs: [{ kind: 'plan' }] } },
    { ...p.args.modelRouting, nextHypothesis: { strategyKey: 'new' } }];
  for (const modelRouting of bad) {
    const result = await p.call('forge_route', { ...p.args, modelRouting });
    assert.equal(result.isError, true, JSON.stringify(modelRouting));
    assert.deepEqual(await readFile(p.target), before);
  }
  const host = await p.call('forge_route', { ...p.args, hostCapabilities: { turnModelSelection: true } });
  assert.equal(host.isError, true);
  assert.deepEqual(await readFile(p.target), before);
});

test('direct opt-in arguments reject getters and non-JSON without invoking caller code', async t => {
  const dir = await sandbox(t);
  const probe = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    const { dispatch } = await import(${JSON.stringify(moduleURL)});
    let reads = 0;
    const base = ${JSON.stringify({ complexity: 'simple', modelRouting: request() })};
    const outer = { ...base };
    Object.defineProperty(outer, 'resultLevel', { enumerable: true, get() { reads++; return 'full'; } });
    const inner = structuredClone(base);
    Object.defineProperty(inner.modelRouting, 'version', { enumerable: true, get() { reads++; return 1; } });
    const envelope = { complexity: 'simple' };
    Object.defineProperty(envelope, 'modelRouting', { enumerable: true, get() { reads++; return base.modelRouting; } });
    const cycle = { ...base }; cycle.extra = cycle;
    const variants = [outer, inner, envelope, cycle, { ...base, extra: undefined },
      { ...base, extra: () => {} }, { ...base, extra: NaN }];
    const results = [];
    for (const args of variants) results.push(await dispatch({ method: 'tools/call', params: { name: 'forge_route', arguments: args } }));
    console.log(JSON.stringify({ reads, results }));
  `], { env: environment(dir, 'advisory-v1'), encoding: 'utf8', timeout: 5000 });
  assert.ifError(probe.error);
  assert.equal(probe.status, 0, probe.stderr);
  const result = JSON.parse(probe.stdout);
  assert.equal(result.reads, 0);
  for (const response of result.results) {
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /JSON|data properties|cycles/i);
  }
  assert.deepEqual(await readdir(dir), []);
});

test('direct-call mutation after asynchronous admission cannot alter args or projection', async t => {
  const dir = await sandbox(t);
  const probe = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    const { dispatch } = await import(${JSON.stringify(moduleURL)});
    const call = (name, args) => dispatch({ method: 'tools/call', params: { name, arguments: args } });
    await call('adaptive_initialize_project', { projectId: 'p', goal: 'Detached args', successCriteria: ['verify'] });
    const state = (await call('adaptive_get_state', { projectId: 'p' })).structuredContent.project;
    const args = { projectId: 'p', complexity: 'simple', resultLevel: 'capsule', modelRouting: ${JSON.stringify(request())} };
    args.modelRouting.operationId = 'original';
    args.modelRouting.expectedState = { projectId: 'p', epoch: state.coordination.epoch, revision: state.revision };
    const pending = call('forge_route', args);
    args.modelRouting.operationId = 'mutated'; args.modelRouting.sourceIdentity = 'mutated';
    args.projectId = 'wrong'; args.resultLevel = 'full'; args.complexity = 'complex';
    const result = await pending;
    const saved = (await call('adaptive_get_state', { projectId: 'p' })).structuredContent.project;
    console.log(JSON.stringify({ result, saved }));
  `], { env: environment(dir, 'advisory-v1'), encoding: 'utf8', timeout: 5000 });
  assert.ifError(probe.error);
  assert.equal(probe.status, 0, probe.stderr);
  const { result, saved } = JSON.parse(probe.stdout);
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.decisionCapsule.identity.projectId, 'p');
  assert.equal(saved.modelRouting.decisions[0].id, 'original');
  assert.equal(saved.modelRouting.decisions[0].sourceIdentity, 'source:v1');
  assert.equal(saved.efficiency.lastRoute.complexity, 'simple');
});

test('all projectless projections preserve advice limits and unmet verification', async t => {
  const c = await client(t, { mode: 'advisory-v1' });
  let advice;
  for (const resultLevel of ['full', 'summary', 'capsule']) {
    const result = await c.call('forge_route', { complexity: 'complex', ...optimistic,
      modelRouting: request(), resultLevel, includeContext: true });
    assert.equal(result.isError, undefined);
    const body = result.structuredContent;
    adviceLimits(body.modelAdvice);
    assert.equal(body.modelAdvice.assessmentSource, 'unknown');
    assert.notEqual(body.modelAdvice.policyAction, 'COMPLETE');
    assert.equal(body.route.completionRecommended, false);
    assert.equal(body.route.wasteReasons.includes('success_verified'), false);
    assert.notEqual(body.route.reasoningRecommendation.reason, 'success_verified');
    assert.equal(body.decisionCapsule, null);
    assert.match(body.contextUnavailable, /projectId/);
    assert.equal(Object.hasOwn(body, 'identity'), false);
    assert.equal(Object.hasOwn(body, 'handoffRequest'), false);
    advice ??= body.modelAdvice;
    assert.deepEqual(body.modelAdvice, advice);
  }
  const benefit = await c.call('forge_route', { complexity: 'complex', modelRouting: request({
    benefit: { kind: 'dependency_risk', reason: 'Check contract', refs: [
      { projectId: 'missing', epoch: 'missing', kind: 'plan', id: 'risk' }] },
  }) });
  assert.equal(benefit.structuredContent.modelAdvice.policyAction, 'DEFER_ESCALATION');
  assert.equal(benefit.structuredContent.modelAdvice.recommendedModel, null);
  assert.equal(Object.hasOwn(benefit.structuredContent, 'handoffRequest'), false);
  for (const patch of [{ operationId: 'forbidden' }, { expectedState: { projectId: 'p', epoch: 'x', revision: 1 } }]) {
    assert.equal((await c.call('forge_route', { complexity: 'simple', modelRouting: request(patch) })).isError, true);
  }
});

test('startup policy is server-owned and handoff requires a fresh eligible transition', async t => {
  const c = await client(t, { mode: 'advisory-v1' });
  const denied = await c.call('forge_route', { complexity: 'simple', modelRouting: request({ userPreference: 'astra' }),
    runtime: { eligibility: { allowedModels: ['gpt-6-astra'] }, observedModel: 'gpt-6-astra' } });
  assert.equal(denied.structuredContent.modelAdvice.recommendedModel, null);
  assert.ok(denied.structuredContent.modelAdvice.reasonCodes.includes('preference_ineligible'));
  assert.equal(Object.hasOwn(denied.structuredContent, 'handoffRequest'), false);
  const dual = await client(t, { mode: 'advisory-v1', extra: { ASTRA_ALLOWED_MODELS: 'gpt-6-astra' } });
  for (const currentModel of ['gpt-6.1-sol', ' GPT-6-ASTRA ', null]) {
    const result = await dual.call('forge_route', { complexity: 'simple', modelRouting: request({ userPreference: 'astra', currentModel }) });
    assert.equal(result.isError, undefined);
    const body = result.structuredContent;
    assert.equal(body.modelAdvice.recommendedModel, 'gpt-6-astra');
    if (currentModel === ' GPT-6-ASTRA ') assert.equal(Object.hasOwn(body, 'handoffRequest'), false);
    else assert.deepEqual(body.handoffRequest, { status: 'user_action_required', requestedModel: 'gpt-6-astra',
      capsule: null, persistedContextStatus: 'unavailable', switched: false, observedModel: null,
      executionStatus: 'not_attempted', availability: 'unknown', quota: 'unknown' });
  }
});

test('stateful replay preserves historical receipt across projections and labels current context', async t => {
  const p = await project(t, { extra: { ASTRA_ALLOWED_MODELS: 'gpt-6-astra' } });
  p.args.modelRouting.userPreference = 'astra';
  const fresh = (await p.call('forge_route', { ...p.args, ...optimistic })).structuredContent;
  adviceLimits(fresh.modelAdvice);
  assert.equal(fresh.replayed, false);
  assert.equal(fresh.route.completionRecommended, false);
  assert.equal(fresh.handoffRequest.persistedContextStatus, 'available');
  assert.deepEqual(fresh.handoffRequest.capsule, fresh.modelHandoff);
  const saved = JSON.parse(await readFile(p.target, 'utf8'));
  const receipt = saved.modelRouting.operations['route-1'];
  assert.equal(Object.hasOwn(receipt.response, 'handoffRequest'), false);
  // The semantic request includes the optimistic signals on replay as well.
  p.args = { ...p.args, ...optimistic };
  await p.call('forge_observe', { projectId: 'p', operation: 'observation', observation: 'New current context' });
  const bytes = await readFile(p.target);
  const restricted = await client(t, { dir: p.dir, mode: 'advisory-v1' });
  for (const resultLevel of ['full', 'summary', 'capsule']) {
    const result = await restricted.call('forge_route', { ...p.args, resultLevel,
      ...(resultLevel === 'capsule' ? {} : { includeContext: true }),
      hostCapabilities: { deferredDiscovery: true, allowedSubset: false, discoveryAvailable: true } });
    assert.equal(result.isError, undefined);
    const body = result.structuredContent;
    assert.equal(body.replayed, true);
    assert.deepEqual(body.modelAdvice, receipt.response.modelAdvice);
    assert.deepEqual(body.modelHandoff, receipt.response.modelHandoff);
    assert.deepEqual(body.identity, receipt.response.identity);
    assert.equal(Object.hasOwn(body, 'decisionCapsule'), false);
    assert.ok(body.currentDecisionCapsule.identity.revision > body.identity.revision);
    assert.equal(Object.hasOwn(body, 'handoffRequest'), false);
    adviceLimits(body.modelAdvice);
    assert.deepEqual(await readFile(p.target), bytes);
  }
  assert.deepEqual(JSON.parse(await readFile(p.target, 'utf8')).modelRouting.operations['route-1'], receipt);
});

test('state conflicts expose current identity and resync before mutation', async t => {
  const p = await project(t);
  const before = await readFile(p.target);
  for (const [patch, code] of [[{ epoch: 'old' }, 'STATE_EPOCH_CONFLICT'], [{ revision: 0 }, 'REVISION_CONFLICT']]) {
    const result = await p.call('forge_route', { ...p.args, modelRouting: { ...p.args.modelRouting,
      expectedState: { ...p.args.modelRouting.expectedState, ...patch } } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, code);
    assert.deepEqual(result.structuredContent.identity, getStateIdentity(p.state));
    assert.deepEqual(result.structuredContent.resync.fullContext, { tool: 'forge_context', arguments: { projectId: 'p', detail: 'full' } });
    assert.deepEqual(await readFile(p.target), before);
  }
});

test('supported COMPLETE alone authorizes positive flags; negative reports retain verification in every projection', async t => {
  const p = await project(t);
  const fixture = routingFixture();
  supportAllCriteria(fixture.project);
  const raw = { ...JSON.parse(await readFile(p.target, 'utf8')), ...fixture.project, projectId: 'p' };
  raw.coordination.epoch = p.state.coordination.epoch;
  const store = new ProjectStore(p.dir);
  for (const resultLevel of ['full', 'summary', 'capsule']) {
    for (const negative of [{}, { importantUncertainty: true }, { contradictionRemaining: true },
      { meaningfulRiskRemaining: true }, { unmetSuccessCriteria: ['external regression'] }]) {
      await writeFile(p.target, JSON.stringify(raw));
      const expectedState = getStateIdentity(await store.getProject('p'));
      const result = await p.call('forge_route', { complexity: 'simple', projectId: 'p', resultLevel,
        ...optimistic, ...negative, modelRouting: request({ operationId: 'complete', expectedState }) });
      assert.equal(result.isError, undefined);
      const body = result.structuredContent;
      const complete = Object.keys(negative).length === 0;
      assert.equal(body.modelAdvice.action === 'COMPLETE', complete);
      assert.equal(body.route.completionRecommended, complete);
      assert.equal(body.route.wasteReasons.includes('success_verified'), complete);
      if (!complete) adviceLimits(body.modelAdvice);
      assert.equal(Object.hasOwn(body, 'handoffRequest'), false);
    }
  }
});

test('feature-off rollback keeps full, recovery, reference and adaptive reads reachable', async t => {
  const p = await project(t);
  await p.call('forge_route', p.args);
  const before = await readFile(p.target);
  const off = await client(t, { dir: p.dir });
  const state = (await off.call('adaptive_get_state', { projectId: 'p' })).structuredContent.project;
  assert.equal(state.modelRouting.decisions.length, 1);
  const ref = { ...getStateIdentity(state), kind: 'goal', id: state.goalGraph[0].id,
    revision: state.goalGraph[0].revision };
  for (const args of [{ detail: 'full' }, { detail: 'recovery' }, { references: [ref] }, { resultLevel: 'capsule' }]) {
    const result = await off.call('forge_context', { projectId: 'p', ...args });
    assert.equal(result.isError, undefined);
    assert.ok(result.structuredContent.context || result.structuredContent.recovery);
  }
  for (const name of ['adaptive_get_context', 'adaptive_get_state', 'adaptive_list_projects']) {
    assert.equal((await off.call(name, { projectId: 'p', detail: 'full' })).isError, undefined);
  }
  assert.deepEqual(await readFile(p.target), before);
  const legacy = await off.call('forge_route', { projectId: 'p', complexity: 'simple' });
  assert.equal(Object.hasOwn(legacy.structuredContent, 'modelAdvice'), false);
  const after = (await off.call('adaptive_get_state', { projectId: 'p' })).structuredContent.project;
  assert.deepEqual(after.modelRouting, state.modelRouting);
});
