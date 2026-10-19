import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getStateIdentity } from '../server/coordination-core.mjs';
import { makeStateRef } from '../server/state-references.mjs';
import { policyBudget } from '../server/efficiency-governor.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = path.join(root, 'server/mcp-server.mjs');
const baseline = path.join(root, 'tests/fixtures/v262-routing-baseline/server/mcp-server.mjs');
const names = ['forge_route', 'forge_goal', 'forge_context', 'forge_observe', 'forge_plan',
  'forge_evaluate', 'forge_adapt', 'forge_checkpoint', 'forge_consolidate', 'adaptive_route_task',
  'adaptive_get_context', 'adaptive_initialize_project', 'adaptive_get_state', 'adaptive_list_projects',
  'adaptive_record_observation', 'adaptive_record_hypothesis', 'adaptive_record_experiment',
  'adaptive_checkpoint', 'adaptive_consolidate'];
const dual = { ASTRA_REQUIRED_MODEL: 'gpt-6.1-sol', ASTRA_ALLOWED_MODELS: 'gpt-6.1-sol,gpt-6-astra' };
const astraOnly = { ASTRA_REQUIRED_MODEL: 'gpt-6-astra' };
const sourceIdentity = 'source:task8-integration-v1';
const constraints = ['Preserve legal bytes', 'Do not discard counter-evidence'];
const request = patch => ({ version: 1, workUnitId: 'dependency-contract', sourceIdentity,
  currentModel: 'gpt-6.1-sol', userPreference: 'auto', forbiddenModels: [], benefit: null,
  nextHypothesis: null, stableBoundary: false, receiverCanResolveReferences: false, ...patch });

function environment(data, mode, eligibility = {}) {
  const env = { ...process.env };
  for (const key of ['ASTRA_REQUIRED_MODEL', 'ASTRA_ALLOWED_MODELS', 'ASTRA_FORGE_MODEL_ROUTING']) delete env[key];
  return { ...env, ASTRA_PROJECT_FORGE_DATA_DIR: data, PLUGIN_DATA: data, ...eligibility,
    ...(mode === undefined ? {} : { ASTRA_FORGE_MODEL_ROUTING: mode }) };
}

async function sandbox(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'forge-routing-integration-'));
  const cwd = path.join(dir, 'unrelated cwd [task8] # %');
  const data = path.join(dir, 'state [task8] # %');
  await mkdir(cwd);
  const clients = [];
  t.after(async () => {
    let outcomes;
    try { outcomes = await Promise.allSettled(clients.map(c => c.close())); }
    finally { await rm(dir, { recursive: true, force: true }); }
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  });
  return { cwd, data, clients };
}

// A real newline-delimited stdio client, with no dispatch/store substitutions.
async function client(box, { mode, eligibility, entry = server } = {}) {
  const child = spawn(process.execPath, [entry, '--stdio'], {
    cwd: box.cwd, env: environment(box.data, mode, eligibility), stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '', stderr = '', id = 0, fatal = null, stopped = false;
  const pending = new Map();
  const fail = error => {
    fatal ??= error;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    if (!stopped) fail(new Error(`MCP exited unexpectedly (${code ?? signal}): ${stderr}`));
    resolve();
  }));
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const reply = JSON.parse(line);
        assert.equal(reply.jsonrpc, '2.0');
        const item = pending.get(reply.id);
        assert.ok(item, `Unexpected MCP response id ${reply.id}`);
        pending.delete(reply.id);
        clearTimeout(item.timer);
        if (reply.error) item.reject(new Error(reply.error.message));
        else item.resolve(reply.result);
      } catch (error) { fail(error); }
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (fatal || stopped) return reject(fatal ?? new Error('MCP client is closed'));
    const next = ++id;
    const timer = setTimeout(() => {
      pending.delete(next);
      reject(new Error(`MCP timeout: ${method}`));
    }, 5000);
    pending.set(next, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: next, method, params })}\n`);
  });
  const c = { rpc, data: box.data,
    invoke: (name, args = {}) => rpc('tools/call', { name, arguments: args }),
    async call(name, args = {}) {
      const result = await c.invoke(name, args);
      assert.equal(result.isError, undefined, result.content?.[0]?.text);
      return result.structuredContent;
    },
    async close() {
      if (!stopped) {
        stopped = true;
        if (pending.size) fail(new Error('MCP closed with pending requests'));
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await closed;
      }
      assert.ifError(fatal);
      assert.equal(stderr, '');
      assert.equal(buffer, '');
    },
  };
  box.clients.push(c);
  c.initialization = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'task8-integration', version: '1' } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  assert.deepEqual(await rpc('ping'), {});
  return c;
}

const state = async c => (await c.call('adaptive_get_state', { projectId: 'p' })).project;
async function bytes(c) {
  const files = (await readdir(c.data)).filter(name => name.endsWith('.json'));
  assert.equal(files.length, 1);
  return readFile(path.join(c.data, files[0]));
}
function incompleteAdvice(body) {
  assert.equal(body.modelAdvice.advisory, true);
  assert.equal(body.modelAdvice.verificationPreserved, true);
  assert.equal(body.modelAdvice.executionStatus, 'not_attempted');
  assert.equal(body.modelAdvice.observedModel, null);
  assert.equal(body.modelAdvice.remainingVerifiedCost, null);
  assert.equal(body.modelAdvice.calibration, 'not_measured');
  assert.notEqual(body.modelAdvice.policyAction, 'COMPLETE');
  assert.ok(body.modelAdvice.unmetCriteria.length > 0);
  assert.equal(body.route.completionRecommended, false);
  assert.equal(body.route.wasteReasons.includes('success_verified'), false);
  assert.notEqual(body.route.reasoningRecommendation.reason, 'success_verified');
}

test('routing integration keeps all 19 tools across both approved eligibility fixtures', async t => {
  for (const [label, eligibility] of [['default Sol', {}], ['explicit dual', dual]]) {
    for (const mode of ['off', 'advisory-v1']) {
      await t.test(`${label}, ${mode}`, async t => {
        const c = await client(await sandbox(t), { mode, eligibility });
        const catalog = await c.rpc('tools/list');
        assert.deepEqual(catalog.tools.map(tool => tool.name), names);
        const routeSchema = catalog.tools.find(tool => tool.name === 'forge_route').inputSchema;
        assert.deepEqual(routeSchema.required, ['complexity']);
        assert.equal(Object.hasOwn(routeSchema.properties, 'modelRouting'), mode === 'advisory-v1');
        assert.deepEqual(c.initialization.capabilities.experimental,
          mode === 'advisory-v1' ? { modelRouting: { version: 1, mode } } : undefined);
        await c.call('adaptive_initialize_project', { projectId: 'p', goal: 'Verify legacy integration',
          constraints, successCriteria: ['mandatory contract check'] });
        const legacy = await c.call('forge_route', { projectId: 'p', complexity: 'moderate' });
        assert.equal(Object.hasOwn(legacy, 'modelAdvice'), false);
        assert.equal(legacy.noticeRequired, true);
        await c.call('forge_adapt', { projectId: 'p', operation: 'acknowledge_usage', firstUseNoticeAcknowledged: true });
        const goal = (await c.call('forge_goal', { projectId: 'p', operation: 'create', parentId: 'goal-root',
          title: 'Check compatibility', successCriteria: ['legacy regression'] })).goal;
        const plan = (await c.call('forge_plan', { projectId: 'p', goalId: goal.id,
          action: 'Inspect legacy wire response', why: 'Resolve the registered check', usageImpact: 'LOW' })).plan;
        await c.call('forge_observe', { projectId: 'p', operation: 'observation', observation: 'Legacy request reached stdio' });
        const evaluation = (await c.call('forge_evaluate', { projectId: 'p', goalId: goal.id, planId: plan.id,
          outcome: 'partially_verified', summary: 'Wire response inspected; regression remains',
          missingCriteria: ['legacy regression'] })).evaluation;
        const full = (await c.call('forge_context', { projectId: 'p', detail: 'full' })).context.project;
        assert.deepEqual(full.constraints, constraints);
        assert.equal(full.evaluations[0].id, evaluation.id);
        const recovery = (await c.call('forge_context', { projectId: 'p', detail: 'recovery' })).recovery;
        assert.equal(recovery.lastEvaluation.id, evaluation.id);
        const expanded = (await c.call('forge_context', { projectId: 'p',
          references: [makeStateRef(full, 'goal', full.goalGraph[0])] })).context;
        assert.equal(expanded.references[0].record.id, 'goal-root');
        assert.equal((await c.call('adaptive_route_task', { complexity: 'simple' })).route.profile, 'off');
        await c.call('adaptive_record_observation', { projectId: 'p', observation: 'Legacy writer stays available' });
        assert.equal((await c.call('adaptive_get_context', { projectId: 'p', detail: 'full' })).context.project.projectId, 'p');
        assert.equal((await c.call('adaptive_list_projects')).projects[0].projectId, 'p');
        if (mode === 'advisory-v1') {
          const current = await state(c);
          const advice = await c.call('forge_route', { projectId: 'p', complexity: 'moderate',
            modelRouting: request({ operationId: 'matrix-route', expectedState: getStateIdentity(current) }) });
          incompleteAdvice(advice);
          assert.equal(advice.modelAdvice.recommendedModel, 'gpt-6.1-sol');
        } else {
          const before = await bytes(c);
          const denied = await c.invoke('forge_route', { projectId: 'p', complexity: 'simple', modelRouting: null });
          assert.equal(denied.isError, true);
          assert.match(denied.content[0].text, /model routing.*disabled/i);
          assert.deepEqual(await bytes(c), before);
        }
      });
    }
  }
});

test('stdio startup is CWD-independent', async t => {
  const old = await client(await sandbox(t), { entry: baseline });
  const current = await client(await sandbox(t));
  const on = await client(await sandbox(t), { mode: 'advisory-v1', eligibility: dual });
  assert.deepEqual(current.initialization, old.initialization);
  assert.deepEqual(await current.rpc('tools/list'), await old.rpc('tools/list'));
  for (const c of [old, current, on]) {
    assert.deepEqual((await c.rpc('tools/list')).tools.map(tool => tool.name), names);
    // An old client omits the envelope even when the new server advertises it.
    assert.deepEqual(await c.call('forge_route', { complexity: 'moderate' }),
      await old.call('forge_route', { complexity: 'moderate' }));
  }
  assert.equal(Object.hasOwn(current.initialization.capabilities, 'experimental'), false);
});

test('hook eligibility remains independent of stdio advice and caller model claims', async t => {
  const box = await sandbox(t);
  for (const [eligibility, allowed] of [[{}, ['gpt-6.1-sol']], [dual, ['gpt-6.1-sol', 'gpt-6-astra']],
    [astraOnly, ['gpt-6-astra']]]) {
    for (const mode of ['off', 'advisory-v1']) {
      for (const model of ['gpt-6.1-sol', 'gpt-6-astra', 'unknown']) {
        const run = spawnSync(process.execPath, [path.join(root, 'hooks/astra-model-gate.mjs')], {
          cwd: box.cwd, env: environment(box.data, mode, eligibility), encoding: 'utf8', timeout: 5000,
          input: JSON.stringify({ hook_event_name: 'PreToolUse', model,
            tool_name: 'mcp__astra-project-forge__forge_context', tool_input: { model: allowed[0] } }),
        });
        assert.ifError(run.error);
        assert.equal(run.status, 0, run.stderr);
        assert.equal(run.stderr, '');
        assert.equal(JSON.parse(run.stdout).hookSpecificOutput?.permissionDecision === 'deny', !allowed.includes(model));
      }
    }
  }
});

async function recoveryScenario(c) {
  await c.call('adaptive_initialize_project', { projectId: 'p', goal: 'Resume the dependency contract safely',
    constraints, successCriteria: ['mandatory source check', 'mandatory regression check'] });
  const goal = (await c.call('forge_goal', { projectId: 'p', operation: 'create', parentId: 'goal-root',
    title: 'Resolve the dependency contract', successCriteria: ['mandatory contract check'] })).goal;
  await c.call('forge_observe', { projectId: 'p', operation: 'observation',
    observation: 'A source-only counterexample remains relevant across model reports',
    evidenceRecord: { evidenceId: 'source-counterexample', kind: 'test', target: 'source-only counterexample',
      dependencies: [sourceIdentity], dependencyIds: ['source'], freshness: 'fresh',
      result: { synthetic: true, counterexample: 'consumer rejects the proposed contract' } } });
  await c.call('forge_observe', { projectId: 'p', operation: 'claim', statement: 'The proposed contract is safe',
    claimStatus: 'contradicted', counterEvidenceIds: ['source-counterexample'] });
  const failed = (await c.call('forge_plan', { projectId: 'p', goalId: 'goal-root',
    action: 'Probe the original contract', why: 'Discriminate the original strategy',
    strategyKey: 'original-contract', usageImpact: 'LOW' })).plan;
  await c.call('forge_evaluate', { projectId: 'p', goalId: 'goal-root', planId: failed.id, outcome: 'falsified',
    summary: 'The original contract fails the consumer counterexample', evidenceIds: ['source-counterexample'],
    missingCriteria: ['mandatory regression check'] });
  await c.call('forge_adapt', { projectId: 'p', operation: 'failure', failureCategory: 'wrong_hypothesis',
    failedAction: 'Apply the original contract', diagnosis: 'The consumer counterexample contradicts the hypothesis',
    nextStrategy: 'Inspect the dependency boundary before proposing another contract' });
  const risk = (await c.call('forge_plan', { projectId: 'p', goalId: goal.id,
    action: 'Determine which dependency contract keeps consumers correct',
    why: 'A wrong dependency contract invalidates the mandatory consumer regression',
    expectedEvidence: 'A discriminating contract check before modifying consumers',
    risk: 'high', verificationRisk: 'high', expectedDecisionImpact: 'high', reversible: false,
    strategyKey: 'inspect-boundary', usageImpact: 'LOW' })).plan;
  for (let index = 0; index < 7; index++) {
    await c.call('forge_observe', { projectId: 'p', operation: 'observation',
      observation: `Later bookkeeping ${index}; original contradiction remains unresolved` });
  }
  await c.call('forge_checkpoint', { projectId: 'p', summary: 'Counterexample recorded; contract verification remains open',
    decisions: constraints, nextSteps: ['Resolve dependency contract and run mandatory regressions'],
    remainingUnknowns: ['Which contract preserves the consumer invariant?'] });
  const route = await c.call('forge_route', { projectId: 'p', complexity: 'complex', uncertainty: 'high' });
  assert.equal(route.noticeRequired, true);
  assert.equal(route.deepNoticeRequired, true);
  await c.call('forge_adapt', { projectId: 'p', operation: 'acknowledge_usage',
    firstUseNoticeAcknowledged: true, deepWarningAcknowledged: true });
  const original = await state(c);
  const args = { projectId: 'p', complexity: 'moderate', modelRouting: request({ operationId: 'handoff-1',
    expectedState: getStateIdentity(original), benefit: { kind: 'dependency_risk',
      reason: 'Resolve which dependency contract preserves consumers before changing them',
      refs: [makeStateRef(original, 'plan', original.plans.find(plan => plan.id === risk.id))] } }) };
  return { original, args };
}

function preserved(original, current) {
  assert.equal(current.schemaVersion, 2);
  assert.equal(current.projectId, original.projectId);
  assert.equal(current.coordination.epoch, original.coordination.epoch);
  assert.ok(current.revision >= original.revision);
  assert.deepEqual(current.constraints, constraints);
  assert.deepEqual(current.successCriteria, original.successCriteria);
  for (const section of ['goalGraph', 'claims', 'plans', 'evaluations', 'observations', 'checkpoints', 'adaptations']) {
    for (const record of original[section]) {
      assert.deepEqual(current[section].find(item => item.id === record.id), record, `${section}:${record.id}`);
    }
  }
  assert.deepEqual(current.efficiency.evidenceCache, original.efficiency.evidenceCache);
  assert.equal(current.efficiency.evidenceCache[0].freshness, 'fresh');
  assert.deepEqual(current.efficiency.failedStrategies, original.efficiency.failedStrategies);
  assert.deepEqual(current.coordination.criteria, original.coordination.criteria);
  assert.equal(current.usage.firstUseNoticeAcknowledged, true);
  assert.equal(current.usage.deepWarningAcknowledged, true);
}

function handoffContext(body, original) {
  incompleteAdvice(body);
  assert.equal(body.modelAdvice.policyAction, 'ESCALATE_ASTRA');
  assert.equal(body.modelAdvice.action, 'REQUEST_USER_CHOICE');
  assert.equal(body.modelAdvice.recommendedModel, 'gpt-6-astra');
  assert.equal(body.noticeRequired, false);
  assert.equal(body.deepNoticeRequired, false);
  assert.deepEqual(body.handoffRequest, { status: 'user_action_required', requestedModel: 'gpt-6-astra',
    capsule: body.modelHandoff, persistedContextStatus: 'available', switched: false, observedModel: null,
    executionStatus: 'not_attempted', availability: 'unknown', quota: 'unknown' });
  const h = body.modelHandoff;
  assert.deepEqual(h.identity, body.identity);
  assert.equal(h.epoch, original.coordination.epoch);
  assert.equal(h.revision, original.revision + 1);
  assert.deepEqual(h.sourceIdentity, { value: sourceIdentity, source: 'reported' });
  assert.deepEqual(h.currentModel, { value: 'gpt-6.1-sol', source: 'reported' });
  assert.equal(h.observedModel, null);
  assert.deepEqual(h.constraints, constraints);
  assert.ok(h.unmetCriteria.some(item => item.includes('mandatory regression check')));
  assert.ok(h.requiredVerification.some(item => item.criterion === 'mandatory contract check'));
  const claim = h.claims.find(item => item.id === original.claims[0].id);
  assert.equal(claim.status, 'contradicted');
  assert.equal(claim.counterEvidenceRefs[0].id, original.efficiency.evidenceCache[0].key);
  assert.ok(h.contradictions.some(item => item.claimId === claim.id));
  assert.deepEqual(h.failedStrategies, original.efficiency.failedStrategies);
  assert.deepEqual(h.referenceBodies.find(item => item.record?.evidenceId === 'source-counterexample').record,
    original.efficiency.evidenceCache[0]);
  // A limited capsule can omit old optional history; full/reference resync stays explicit.
  if (h.incomplete) { assert.ok(h.resync); assert.match(h.resumeInstructions, /resync/i); }
}

test('manual handoff reconciles interruption and intervening writer without replaying current completion', async t => {
  const box = await sandbox(t);
  const first = await client(box, { mode: 'advisory-v1', eligibility: dual });
  const { original, args } = await recoveryScenario(first);
  const historical = await first.call('forge_route', args);
  handoffContext(historical, original);
  assert.equal(historical.replayed, false);
  const committed = await state(first);
  preserved(original, committed);
  assert.deepEqual(committed.efficiency.ledger, original.efficiency.ledger);
  await first.close();

  const writer = await client(box, { mode: 'off' });
  await writer.call('forge_observe', { projectId: 'p', operation: 'observation',
    observation: 'An intervening writer found an additional consumer condition' });
  await writer.call('forge_observe', { projectId: 'p', operation: 'claim', claimStatus: 'contradicted',
    statement: 'The later consumer condition is resolved', counterEvidenceIds: ['source-counterexample'] });
  await writer.call('forge_goal', { projectId: 'p', operation: 'create', parentId: 'goal-root',
    title: 'Verify the later consumer condition', successCriteria: ['mandatory intervening-writer check'] });
  const intervening = await state(writer);
  assert.ok(intervening.revision > historical.identity.revision);
  preserved(original, intervening);
  await writer.close();

  const resumedCwd = path.join(box.cwd, 'resumed [writer] # %');
  await mkdir(resumedCwd);
  const resumed = await client({ ...box, cwd: resumedCwd }, { mode: 'advisory-v1', eligibility: dual });
  assert.deepEqual((await resumed.call('forge_context', { projectId: 'p', detail: 'full' })).context.project, intervening);
  const recovery = (await resumed.call('forge_context', { projectId: 'p', detail: 'recovery' })).recovery;
  assert.equal(recovery.latestCheckpoint.id, original.checkpoints[0].id);
  assert.equal(recovery.lastEvaluation.outcome, 'falsified');
  assert.ok(recovery.openClaims.some(claim => claim.id === intervening.claims.at(-1).id));
  const before = await bytes(resumed);
  for (const resultLevel of ['full', 'summary', 'capsule']) {
    const replay = await resumed.call('forge_route', { ...args, resultLevel, includeContext: true });
    incompleteAdvice(replay);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.identity, historical.identity);
    assert.deepEqual(replay.modelAdvice, historical.modelAdvice);
    assert.deepEqual(replay.modelHandoff, historical.modelHandoff);
    assert.equal(Object.hasOwn(replay, 'handoffRequest'), false);
    assert.equal(Object.hasOwn(replay, 'decisionCapsule'), false);
    assert.deepEqual(replay.currentDecisionCapsule.identity, getStateIdentity(intervening));
    assert.ok(replay.currentDecisionCapsule.unmetCriteria.some(item => item.criterion === 'mandatory intervening-writer check'));
    assert.ok(replay.currentDecisionCapsule.claims.some(claim => claim.id === intervening.claims.at(-1).id));
    assert.deepEqual(await bytes(resumed), before);
  }
  for (const [patch, code] of [[{}, 'REVISION_CONFLICT'], [{ epoch: 'wrong-generation' }, 'STATE_EPOCH_CONFLICT']]) {
    const rejected = await resumed.invoke('forge_route', { ...args, modelRouting: { ...args.modelRouting,
      operationId: `new-${code}`, expectedState: { ...args.modelRouting.expectedState, ...patch } } });
    assert.equal(rejected.isError, true);
    assert.equal(rejected.structuredContent.code, code);
    assert.deepEqual(rejected.structuredContent.identity, getStateIdentity(intervening));
    assert.deepEqual(rejected.structuredContent.resync.fullContext,
      { tool: 'forge_context', arguments: { projectId: 'p', detail: 'full' } });
    assert.deepEqual(await bytes(resumed), before);
  }
  const full = (await resumed.call('forge_context', { projectId: 'p', detail: 'full' })).context.project;
  const refs = [makeStateRef(full, 'evidence', full.efficiency.evidenceCache[0]),
    makeStateRef(full, 'claim', full.claims[0]), makeStateRef(full, 'plan', full.plans.at(-1))];
  const expanded = (await resumed.call('forge_context', { projectId: 'p', references: refs })).context;
  assert.ok(expanded.references.every(item => item.status === 'unchanged'));
  assert.deepEqual(await bytes(resumed), before);
  const fresh = await resumed.call('forge_route', { ...args, modelRouting: { ...args.modelRouting,
    currentModel: 'gpt-6-astra', stableBoundary: true, operationId: 'resumed-current',
    expectedState: getStateIdentity(full), benefit: { ...args.modelRouting.benefit, refs: [refs[2]] } } });
  incompleteAdvice(fresh);
  assert.equal(fresh.replayed, false);
  assert.equal(fresh.modelAdvice.policyAction, 'KEEP_ASTRA');
  assert.equal(fresh.identity.revision, intervening.revision + 1);
  assert.equal(fresh.identity.epoch, historical.identity.epoch);
  assert.equal(Object.hasOwn(fresh, 'handoffRequest'), false);
  const after = await state(resumed);
  preserved(original, after);
  assert.deepEqual(after.efficiency.ledger, original.efficiency.ledger);
  assert.deepEqual(after.modelRouting.operations['handoff-1'], committed.modelRouting.operations['handoff-1']);
  assert.equal(after.modelRouting.decisions.length, 2);
});

test('roll back pilot without state loss', async t => {
  const box = await sandbox(t);
  const on = await client(box, { mode: 'advisory-v1', eligibility: dual });
  const { original, args } = await recoveryScenario(on);
  const historical = await on.call('forge_route', args);
  handoffContext(historical, original);
  const committed = await state(on);
  await on.close();

  const narrow = await client(box, { mode: 'advisory-v1' });
  const before = await bytes(narrow);
  const replay = await narrow.call('forge_route', { ...args, includeContext: true });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.identity, historical.identity);
  assert.deepEqual(replay.modelAdvice, historical.modelAdvice);
  assert.deepEqual(replay.modelHandoff, historical.modelHandoff);
  assert.equal(Object.hasOwn(replay, 'handoffRequest'), false);
  assert.deepEqual(await bytes(narrow), before);
  const denied = await narrow.call('forge_route', { ...args, modelRouting: { ...args.modelRouting,
    operationId: 'narrow-policy', userPreference: 'astra', expectedState: getStateIdentity(committed) } });
  assert.equal(denied.modelAdvice.recommendedModel, null);
  assert.ok(denied.modelAdvice.reasonCodes.includes('preference_ineligible'));
  assert.equal(Object.hasOwn(denied, 'handoffRequest'), false);
  const narrowed = await state(narrow);
  preserved(original, narrowed);
  assert.deepEqual(narrowed.modelRouting.operations['handoff-1'], committed.modelRouting.operations['handoff-1']);
  await narrow.close();

  for (const eligibility of [{}, astraOnly]) {
    const off = await client(box, { mode: 'off', eligibility });
    assert.deepEqual((await off.rpc('tools/list')).tools.map(tool => tool.name), names);
    assert.equal(Object.hasOwn(off.initialization.capabilities, 'experimental'), false);
    const saved = await state(off);
    preserved(original, saved);
    const readBytes = await bytes(off);
    const full = (await off.call('forge_context', { projectId: 'p', detail: 'full' })).context.project;
    assert.deepEqual(full.modelRouting, narrowed.modelRouting);
    const recovery = (await off.call('forge_context', { projectId: 'p', detail: 'recovery' })).recovery;
    assert.equal(recovery.lastEvaluation.id, original.evaluations[0].id);
    assert.equal(recovery.openClaims[0].status, 'contradicted');
    const expanded = (await off.call('forge_context', { projectId: 'p', references: [
      makeStateRef(full, 'evidence', full.efficiency.evidenceCache[0]),
      makeStateRef(full, 'failedStrategy', full.efficiency.failedStrategies[0]),
    ] })).context;
    assert.equal(expanded.references[0].record.evidenceId, 'source-counterexample');
    assert.equal(expanded.references[1].record.strategyKey, 'original-contract');
    assert.deepEqual((await off.call('adaptive_get_context', { projectId: 'p', detail: 'full' })).context.project, full);
    assert.equal((await off.call('adaptive_list_projects')).projects[0].projectId, 'p');
    assert.deepEqual(await bytes(off), readBytes);
    const disabled = await off.invoke('forge_route', args);
    assert.equal(disabled.isError, true);
    assert.match(disabled.content[0].text, /model routing.*disabled/i);
    assert.deepEqual(await bytes(off), readBytes);
    const legacy = await off.call('forge_route', { projectId: 'p', complexity: 'moderate' });
    assert.equal(Object.hasOwn(legacy, 'modelAdvice'), false);
    const after = await state(off);
    assert.equal(after.revision, saved.revision + 1);
    preserved(original, after);
    assert.deepEqual(after.modelRouting, narrowed.modelRouting);
    await off.close();
  }
});

for (const policy of ['eco', 'balanced', 'performance', 'maximum']) {
  test(`${policy} permits useful MODERATE verification beyond its soft budget without completing`, async t => {
    const c = await client(await sandbox(t), { mode: 'advisory-v1', eligibility: dual });
    await c.call('adaptive_initialize_project', { projectId: 'p', goal: 'Verify the resumed contract',
      constraints, successCriteria: ['mandatory dependency-contract regression'] });
    await c.call('forge_adapt', { projectId: 'p', operation: 'set_efficiency_policy', efficiencyPolicy: policy });
    const budget = policyBudget(policy, 'standard').softCycleBudget;
    const completedCycles = budget + 1;
    const current = await state(c);
    const route = await c.call('forge_route', { projectId: 'p', complexity: 'moderate', uncertainty: 'medium',
      verificationNeeded: true, multiStep: true, completedCycles, candidateWouldVerifySuccessCriterion: true,
      successCriteriaSatisfied: true, evidenceSufficient: true, contradictionRemaining: false, meaningfulRiskRemaining: false,
      modelRouting: request({ operationId: `budget-${policy}`, expectedState: getStateIdentity(current) }) });
    incompleteAdvice(route);
    assert.equal(route.route.profile, 'standard');
    assert.equal(route.route.efficiencyPolicy, policy);
    assert.equal(route.route.softCycleBudget, budget);
    assert.equal(route.route.efficiencyDecision, 'allow');
    const input = { projectId: 'p', goalId: 'goal-root', usageImpact: 'MODERATE',
      action: 'Verify the dependency contract against the resumed source',
      why: 'Resolve the mandatory dependency-contract regression', expectedEvidence: 'A source-bound regression result' };
    const before = await bytes(c);
    const rejected = await c.invoke('forge_plan', input);
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /soft budget.*override|budgetOverride/i);
    assert.deepEqual(await bytes(c), before);
    const budgetOverride = { category: 'unmet_success_criterion', justification:
      'The resumed source snapshot still lacks the mandatory dependency-contract regression result; verify that contract before satisfying the registered criterion.' };
    const plan = (await c.call('forge_plan', { ...input, budgetOverride })).plan;
    assert.equal(plan.usageImpact, 'MODERATE');
    assert.deepEqual(plan.budgetOverride, { ...budgetOverride, policy, completedCycles, softCycleBudget: budget,
      provenance: { source: 'reported', reference: `plan:${plan.id}` } });
    const after = await state(c);
    assert.equal(after.efficiency.ledger.softBudgetOverrides, 1);
    assert.equal(after.efficiency.ledger.usefulCycles, 0);
    assert.equal(after.efficiency.ledger.events.at(-1).provenance.source, 'store');
    const continued = await c.call('forge_route', { projectId: 'p', complexity: 'moderate', completedCycles,
      candidateWouldVerifySuccessCriterion: true, modelRouting: request({ operationId: `after-plan-${policy}`,
        expectedState: getStateIdentity(after) }) });
    incompleteAdvice(continued);
    assert.ok(continued.modelAdvice.unmetCriteria.some(item => item.includes('mandatory dependency-contract regression')));
    assert.equal((await state(c)).plans.length, 1);
  });
}
