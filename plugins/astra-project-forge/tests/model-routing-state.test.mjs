import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../server/state-store.mjs';
import { routingFixture, supportAllCriteria, addFailure, addDependencyRisk, routingRef } from './helpers/model-routing-fixtures.mjs';
import { getStateIdentity } from '../server/coordination-core.mjs';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { buildModelRoutingSnapshot, recommendModel } from '../server/model-router.mjs';
import { createAdvisoryHostAdapter } from '../server/model-host-adapter.mjs';
import { readModelEligibility } from '../server/model-policy.mjs';
import { makeStateRef } from '../server/state-references.mjs';

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-model-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ProjectStore(root);
  const project = await store.initializeProject({ projectId: 'p', goal: 'Atomic routing', successCriteria: ['verify'] });
  const target = path.join(root, (await readdir(root)).find(name => name.endsWith('.json')));
  const { request, runtime } = routingFixture();
  request.expectedState = getStateIdentity(project);
  return { root, store, project, target, runtime, args: { complexity: 'simple', modelRouting: request } };
}

test('advice and workflow state commit in one revision', async t => {
  const { store, args, runtime, target } = await setup(t);
  assert.equal(typeof store.routeProjectWithModelAdvice, 'function');
  const response = await store.routeProjectWithModelAdvice('p', args, runtime);
  const project = JSON.parse(await readFile(target, 'utf8'));
  assert.equal(project.revision, 2);
  assert.equal(project.schemaVersion, 2);
  assert.deepEqual(response.identity, { projectId: 'p', epoch: args.modelRouting.expectedState.epoch, revision: 2 });
  assert.equal(response.replayed, false);
  assert.deepEqual(project.efficiency.lastRoute.profile, response.route.profile);
  assert.equal(project.modelRouting.decisions.length, 1);
  assert.equal(project.modelRouting.decisions[0].revision, 2);
  assert.deepEqual(project.modelRouting.operations['route-1'].response, response);
  assert.equal(response.modelAdvice.executionStatus, 'not_attempted');
  assert.equal(response.modelAdvice.observedModel, null);
  assert.equal(typeof response.modelAdvice.nextObservation === 'string' || response.modelAdvice.nextObservation === null, true);
});

test('identical lost-response retry is read-only including response-only changes', async t => {
  const { store, args, runtime, target } = await setup(t);
  const query = { kind: 'test', target: 'cache replay', dependencies: ['source:v1'] };
  await store.upsertEvidenceRecord('p', { ...query, evidenceId: 'cache-check', dependencyIds: ['source'],
    freshness: 'fresh', result: { synthetic: true } });
  args.cacheRequest = query;
  args.modelRouting.expectedState = getStateIdentity(await store.getProject('p'));
  const first = await store.routeProjectWithModelAdvice('p', args, runtime);
  const bytes = await readFile(target);
  const project = JSON.parse(bytes);
  assert.equal(project.revision, 3);
  assert.equal(project.efficiency.ledger.events.length, 1);
  assert.equal(project.efficiency.ledger.events[0].type, 'reusedEvidence');
  assert.equal(project.efficiency.ledger.events[0].revision, 3);
  assert.equal(first.route.efficiencyDecision, 'reuse');
  assert.equal(first.evidenceRecord.evidenceId, 'cache-check');
  const replay = await store.routeProjectWithModelAdvice('p', { ...args,
    resultLevel: 'full', includeContext: true, hostCapabilities: { synthetic: true } }, runtime);
  assert.deepEqual(replay, { ...first, replayed: true });
  assert.deepEqual(await readFile(target), bytes);
});

test('producer advice for an operator-defined model replays without mutation', async t => {
  const { store, args, target } = await setup(t);
  const runtime = createAdvisoryHostAdapter(readModelEligibility({ ASTRA_REQUIRED_MODEL: 'operator-future' })).describe();
  args.modelRouting.currentModel = 'operator-future';
  args.modelRouting.userPreference = 'stay';
  const first = await store.routeProjectWithModelAdvice('p', args, runtime);
  assert.equal(first.modelAdvice.recommendedModel, 'operator-future');
  assert.equal(first.modelAdvice.hold, null);
  const bytes = await readFile(target);
  assert.deepEqual(await store.routeProjectWithModelAdvice('p', args, runtime), { ...first, replayed: true });
  assert.deepEqual(await readFile(target), bytes);
  assert.equal(first.modelAdvice.action, 'REQUEST_USER_CHOICE');
  assert.equal(first.modelAdvice.policyAction, 'REQUEST_USER_CHOICE');
  assert.ok(first.modelAdvice.nextObservation);
  assert.equal(first.modelHandoff.observedModel, null);
});

async function persistedRiskFixture(t, kind = 'dependency_risk', mixed = false) {
  const context = await setup(t);
  const fixture = kind === 'dependency_risk' ? addDependencyRisk(routingFixture()) : addFailure(routingFixture());
  const raw = { ...JSON.parse(await readFile(context.target, 'utf8')), ...fixture.project,
    projectId: 'p', goal: 'Synthetic persisted hold recovery' };
  raw.coordination.epoch = context.args.modelRouting.expectedState.epoch;
  const record = kind === 'dependency_risk' ? raw.plans[0] : raw.efficiency.failedStrategies[0];
  const causal = makeStateRef(raw, kind === 'dependency_risk' ? 'plan' : 'failedStrategy', record);
  const supporting = makeStateRef(raw, 'evidence', raw.efficiency.evidenceCache[0]);
  await writeFile(context.target, JSON.stringify(raw));
  context.args.modelRouting.benefit = { kind, reason: 'Resolve a source-bound contract',
    refs: mixed ? [causal, supporting] : [causal] };
  return { ...context, causal, supporting };
}

async function resumeRoute(context, operationId, patch = {}) {
  const store = new ProjectStore(context.root);
  const project = await store.getProject('p');
  const args = { ...context.args, modelRouting: { ...context.args.modelRouting,
    benefit: null, currentModel: 'gpt-6-astra', stableBoundary: true, ...patch,
    operationId, expectedState: getStateIdentity(project) } };
  return { args, response: await store.routeProjectWithModelAdvice('p', args, context.runtime) };
}

for (const kind of ['dependency_risk', 'stalled_strategy']) {
  test(`F1 persisted legacy mixed ${kind} hold resolves after resume without rewriting receipts`, async t => {
    const context = await persistedRiskFixture(t, kind, true);
    const { store, args, runtime, target, root, causal, supporting } = context;
    const first = await store.routeProjectWithModelAdvice('p', args, runtime);
    assert.equal(first.modelAdvice.policyAction, 'ESCALATE_ASTRA');
    const raw = JSON.parse(await readFile(target, 'utf8'));
    // Simulate a previously persisted v1 producer's mixed-reference history.
    raw.modelRouting.decisions[0].advice.hold.triggerRefs = [causal, supporting];
    raw.modelRouting.operations['route-1'].response.modelAdvice.hold.triggerRefs = [causal, supporting];
    const historical = structuredClone(raw.modelRouting);
    supportAllCriteria(raw);
    raw.evaluations.push({ id: 'resolved-eval', revision: raw.revision, planId: raw.plans[0].id,
      outcome: 'verified', missingCriteria: [], evidenceIds: ['check-1'] });
    await writeFile(target, JSON.stringify(raw));
    const { response } = await resumeRoute(context, 'resolved');
    assert.equal(response.modelAdvice.action, 'COMPLETE');
    assert.equal(response.route.completionRecommended, true);
    const saved = JSON.parse(await readFile(target, 'utf8'));
    assert.deepEqual(saved.modelRouting.decisions[0], historical.decisions[0]);
    assert.deepEqual(saved.modelRouting.operations['route-1'], historical.operations['route-1']);
    const bytes = await readFile(target);
    const replay = await new ProjectStore(root).routeProjectWithModelAdvice('p', args, runtime);
    assert.deepEqual(replay, { ...historical.operations['route-1'].response, replayed: true });
    assert.deepEqual(await readFile(target), bytes);
  });
}

for (const intervening of ['unresolved', 'preference', 'deferral']) {
  test(`F2 persisted A B A resumes ${intervening} causal history and read-only receipts`, async t => {
    const context = await persistedRiskFixture(t);
    const { store, args, runtime, target, root, causal } = context;
    const first = await store.routeProjectWithModelAdvice('p', args, runtime);
    assert.equal(first.modelAdvice.policyAction, 'ESCALATE_ASTRA');
    if (intervening === 'preference') {
      const { response } = await resumeRoute(context, 'preferred', { userPreference: 'sol' });
      assert.equal(response.modelAdvice.policyAction, 'KEEP_SOL');
      assert.ok(response.modelAdvice.reasonCodes.includes('hold_requires_revalidation'));
    }
    if (intervening === 'deferral') {
      const raw = JSON.parse(await readFile(target, 'utf8'));
      raw.plans = [];
      supportAllCriteria(raw);
      await writeFile(target, JSON.stringify(raw));
      assert.equal((await resumeRoute(context, 'deferred')).response.modelAdvice.policyAction, 'DEFER_ESCALATION');
    }
    await resumeRoute(context, 'unit-B', { workUnitId: 'work-B', currentModel: 'gpt-6.1-sol' });
    const before = JSON.parse(await readFile(target, 'utf8')).modelRouting;
    const { args: returnedArgs, response } = await resumeRoute(context, 'return-A', {
      currentModel: intervening === 'deferral' ? 'gpt-6-astra' : 'gpt-6.1-sol' });
    assert.equal(response.modelAdvice.policyAction, intervening === 'deferral' ? 'DEFER_ESCALATION' : 'KEEP_ASTRA');
    assert.equal(response.route.completionRecommended, false);
    assert.ok(response.modelHandoff.references.some(entry => entry.reference.kind === 'plan'
      && entry.reference.id === causal.id && (intervening !== 'deferral' || entry.status === 'not_found')));
    const saved = JSON.parse(await readFile(target, 'utf8'));
    assert.deepEqual(saved.modelRouting.decisions.slice(0, -1), before.decisions);
    for (const [id, receipt] of Object.entries(before.operations)) assert.deepEqual(saved.modelRouting.operations[id], receipt);
    const bytes = await readFile(target);
    assert.deepEqual(await new ProjectStore(root).routeProjectWithModelAdvice('p', returnedArgs, runtime),
      { ...response, replayed: true });
    assert.deepEqual(await new ProjectStore(root).routeProjectWithModelAdvice('p', args, runtime),
      { ...first, replayed: true });
    assert.deepEqual(await readFile(target), bytes);
  });
}

test('F2 persisted same-scope resolution permits downgrade without resurrecting older holds', async t => {
  const context = await persistedRiskFixture(t);
  await context.store.routeProjectWithModelAdvice('p', context.args, context.runtime);
  const raw = JSON.parse(await readFile(context.target, 'utf8'));
  supportAllCriteria(raw);
  raw.evaluations.push({ id: 'resolved-eval', revision: raw.revision, planId: raw.plans[0].id,
    outcome: 'verified', missingCriteria: [], evidenceIds: ['check-1'] });
  raw.goalGraph.push({ id: 'goal-2', revision: 1, status: 'active', dependencies: [], successCriteria: ['remaining check'] });
  await writeFile(context.target, JSON.stringify(raw));
  assert.equal((await resumeRoute(context, 'resolved-A')).response.modelAdvice.policyAction, 'KEEP_SOL');
  await resumeRoute(context, 'unit-B', { workUnitId: 'work-B', currentModel: 'gpt-6.1-sol' });
  const resolved = JSON.parse(await readFile(context.target, 'utf8'));
  resolved.plans = [];
  resolved.evaluations = [];
  await writeFile(context.target, JSON.stringify(resolved));
  const { response } = await resumeRoute(context, 'return-A', { currentModel: 'gpt-6.1-sol' });
  assert.equal(response.modelAdvice.policyAction, 'KEEP_SOL');
  assert.equal(response.modelAdvice.hold, null);
  assert.equal(response.modelAdvice.reasonCodes.includes('hold_requires_revalidation'), false);
});

test('F2 persisted revalidation with missing causal history blocks completion after preference and other work', async t => {
  const context = await persistedRiskFixture(t);
  await context.store.routeProjectWithModelAdvice('p', context.args, context.runtime);
  const raw = JSON.parse(await readFile(context.target, 'utf8'));
  raw.plans = [];
  supportAllCriteria(raw);
  await writeFile(context.target, JSON.stringify(raw));
  const { args, response } = await resumeRoute(context, 'deferred');
  assert.equal(response.modelAdvice.policyAction, 'DEFER_ESCALATION');
  const truncated = JSON.parse(await readFile(context.target, 'utf8'));
  truncated.modelRouting.decisions.shift();
  delete truncated.modelRouting.operations['route-1'];
  await writeFile(context.target, JSON.stringify(truncated));
  const preferred = await resumeRoute(context, 'preferred', { userPreference: 'sol' });
  assert.equal(preferred.response.modelAdvice.policyAction, 'KEEP_SOL');
  assert.ok(preferred.response.modelAdvice.reasonCodes.includes('hold_requires_revalidation'));
  await resumeRoute(context, 'unit-B', { workUnitId: 'work-B', currentModel: 'gpt-6.1-sol' });
  const resumed = await resumeRoute(context, 'return-A');
  assert.equal(resumed.response.modelAdvice.policyAction, 'DEFER_ESCALATION');
  assert.equal(resumed.response.route.completionRecommended, false);
  const bytes = await readFile(context.target);
  assert.deepEqual(await new ProjectStore(context.root).routeProjectWithModelAdvice('p', args, context.runtime),
    { ...response, replayed: true });
  assert.deepEqual(await readFile(context.target), bytes);
});

test('complete args reject getters and cycles without executing caller code or writing', async t => {
  const { store, args, runtime, target } = await setup(t);
  const bytes = await readFile(target);
  let reads = 0;
  const getter = { ...args };
  Object.defineProperty(getter, 'complexity', { enumerable: true, get() { reads++; return 'simple'; } });
  const innerGetter = structuredClone(args);
  Object.defineProperty(innerGetter.modelRouting, 'version', { enumerable: true, get() { reads++; return 1; } });
  const cycle = { ...args }; cycle.hostCapabilities = cycle;
  for (const bad of [getter, innerGetter, cycle, { ...args, includeContext: undefined },
    { ...args, hostCapabilities: { dangerous: () => {} } }]) {
    await assert.rejects(store.routeProjectWithModelAdvice('p', bad, runtime), /JSON|data properties|cycles/i);
  }
  assert.equal(reads, 0);
  assert.deepEqual(await readFile(target), bytes);
});

test('caller mutation after dispatch cannot alter the validated operation', async t => {
  const { store, args, runtime, target } = await setup(t);
  const pending = store.routeProjectWithModelAdvice('p', args, runtime);
  args.modelRouting.operationId = 'mutated';
  args.modelRouting.sourceIdentity = 'mutated';
  args.complexity = 'complex';
  const result = await pending;
  const saved = JSON.parse(await readFile(target, 'utf8'));
  assert.equal(result.route.complexity, 'simple');
  assert.equal(saved.modelRouting.decisions[0].id, 'route-1');
  assert.equal(saved.modelRouting.decisions[0].sourceIdentity, 'source:v1');
});

test('conflicting operation or state rejects before write', async t => {
  const { store, args, runtime, target } = await setup(t);
  await store.routeProjectWithModelAdvice('p', args, runtime);
  const bytes = await readFile(target);
  const variants = [
    { ...args, risk: 'high' },
    { ...args, modelRouting: { ...args.modelRouting, sourceIdentity: 'source:v2' } },
    ...[{ projectId: 'other' }, { epoch: 'wrong' }, { revision: 0 }, { revision: 99 }].map(patch => ({
      ...args, modelRouting: { ...args.modelRouting, operationId: 'new',
        expectedState: { ...args.modelRouting.expectedState, ...patch } },
    })),
    { ...args, modelRouting: { ...args.modelRouting, version: 2 } },
  ];
  for (const bad of variants) {
    await assert.rejects(store.routeProjectWithModelAdvice('p', bad, runtime), /digest|identity|epoch|revision|version/i);
    assert.deepEqual(await readFile(target), bytes);
  }
});

test('reinitializing a project refuses an old operation even with the same ID', async t => {
  const { store, args, runtime, target } = await setup(t);
  await store.routeProjectWithModelAdvice('p', args, runtime);
  await store.initializeProject({ projectId: 'p', goal: 'New generation' });
  const bytes = await readFile(target);
  await assert.rejects(store.routeProjectWithModelAdvice('p', args, runtime), /epoch|identity/);
  assert.deepEqual(await readFile(target), bytes);
});

test('canonical replay accepts reordered keys and isolates returned receipt objects', async t => {
  const { store, args, runtime, target } = await setup(t);
  const first = await store.routeProjectWithModelAdvice('p', args, runtime);
  const saved = structuredClone(first);
  first.modelAdvice.reasonCodes.push('caller mutation');
  const reordered = Object.fromEntries(Object.entries(args).reverse());
  reordered.modelRouting = Object.fromEntries(Object.entries(args.modelRouting).reverse());
  const bytes = await readFile(target);
  const replay = await store.routeProjectWithModelAdvice('p', reordered, runtime);
  assert.deepEqual(replay, { ...saved, replayed: true });
  replay.modelAdvice.unmetCriteria.length = 0;
  assert.deepEqual(await readFile(target), bytes);
  assert.deepEqual(await store.routeProjectWithModelAdvice('p', args, runtime), { ...saved, replayed: true });
});

for (const operationId of ['__proto__', 'constructor', ' spaced ID ']) {
  test(`arbitrary operation ID ${operationId} stores and replays as own data`, async t => {
    const { store, args, runtime, target } = await setup(t);
    args.modelRouting.operationId = operationId;
    const first = await store.routeProjectWithModelAdvice('p', args, runtime);
    const saved = JSON.parse(await readFile(target, 'utf8'));
    assert.equal(Object.hasOwn(saved.modelRouting.operations, operationId), true);
    assert.equal(Object.getPrototypeOf(saved.modelRouting.operations), Object.prototype);
    assert.deepEqual(await store.routeProjectWithModelAdvice('p', args, runtime), { ...first, replayed: true });
    assert.equal(Object.prototype.digest, undefined);
  });
}

test('malformed or unsupported extension rejects opt-in writes without mutation', async t => {
  const { store, args, runtime, target } = await setup(t);
  const raw = JSON.parse(await readFile(target, 'utf8'));
  for (const extension of [null, [], { version: 7, sentinel: 'future' },
    { version: 1, decisions: {}, operations: {} }, { version: 1, decisions: [], operations: [] },
    { version: 1, decisions: [null], operations: {} },
    { version: 1, decisions: [], operations: { broken: null } }]) {
    await writeFile(target, JSON.stringify({ ...raw, modelRouting: extension }));
    const bytes = await readFile(target);
    await assert.rejects(store.routeProjectWithModelAdvice('p', args, runtime), /extension|modelRouting|version/i);
    assert.deepEqual(await readFile(target), bytes);
  }
});

test('damaged v1 decisions and receipts cannot be silently extended', async t => {
  const { store, args, runtime, target } = await setup(t);
  await store.routeProjectWithModelAdvice('p', args, runtime);
  const saved = JSON.parse(await readFile(target, 'utf8'));
  const next = { ...args, modelRouting: { ...args.modelRouting,
    operationId: 'route-2', expectedState: getStateIdentity(saved) } };
  for (const damage of [
    project => { delete project.modelRouting.decisions[0].advice.reasonCodes; },
    project => { delete project.modelRouting.operations['route-1'].response.route; },
    project => { delete project.modelRouting.operations['route-1']; },
    project => { project.modelRouting.decisions.push(structuredClone(project.modelRouting.decisions[0])); },
  ]) {
    const broken = structuredClone(saved); damage(broken);
    await writeFile(target, JSON.stringify(broken));
    const bytes = await readFile(target);
    await assert.rejects(store.routeProjectWithModelAdvice('p', next, runtime), /modelRouting|receipt|decision/i);
    assert.deepEqual(await readFile(target), bytes);
  }
});

async function heldRoute(t) {
  const context = await setup(t);
  const fixture = addDependencyRisk(routingFixture());
  await context.store.transact('p', project => {
    project.plans.push({ ...fixture.project.plans[0], goalId: project.goalGraph[0].id });
  });
  const project = await context.store.getProject('p');
  const trigger = makeStateRef(project, 'plan', project.plans[0]);
  context.args.modelRouting.expectedState = getStateIdentity(project);
  context.args.modelRouting.benefit = { ...fixture.request.benefit, refs: [trigger] };
  const first = await context.store.routeProjectWithModelAdvice('p', context.args, context.runtime);
  assert.equal(first.modelAdvice.policyAction, 'ESCALATE_ASTRA');
  assert.deepEqual(first.modelAdvice.hold.triggerRefs, [trigger]);
  return { ...context, first, trigger };
}

for (const location of ['decision', 'receipt']) {
  test(`stored v1 nested advice rejects corruption in ${location} before replay and new writes`, async t => {
    const { store, args, runtime, target } = await heldRoute(t);
    const saved = JSON.parse(await readFile(target, 'utf8'));
    const next = { ...args, modelRouting: { ...args.modelRouting,
      operationId: 'next', expectedState: getStateIdentity(saved) } };
    const damages = [
      ['empty hold', advice => { advice.hold = {}; }],
      ['unknown hold model', advice => { advice.hold.model = 'unknown'; }],
      ['missing hold work unit', advice => { delete advice.hold.workUnitId; }],
      ['foreign hold work unit', advice => { advice.hold.workUnitId = 'other-work'; }],
      ['foreign hold source', advice => { advice.hold.sourceIdentity = 'source:other'; }],
      ['unknown hold trigger kind', advice => { advice.hold.triggerKind = 'unknown'; }],
      ['empty hold trigger refs', advice => { advice.hold.triggerRefs = []; }],
      ['malformed hold trigger ref', advice => { advice.hold.triggerRefs = [null]; }],
      ['malformed evidence ref', advice => { advice.evidenceRefs = [null]; }],
      ['unsupported reference kind', advice => { advice.evidenceRefs[0].kind = 'unknown'; }],
      ['unsafe reference revision', advice => { advice.evidenceRefs[0].revision = Number.MAX_SAFE_INTEGER + 1; }],
      ['empty reference scope', advice => { advice.evidenceRefs[0].epoch = ''; }],
      ['unsupported action', advice => { advice.action = 'UNKNOWN_ACTION'; }],
      ['unsupported policy action', advice => { advice.policyAction = 'UNKNOWN_ACTION'; }],
    ];
    for (const [label, damage] of damages) {
      for (const [mode, request] of [['replay', args], ['new operation', next]]) {
        await t.test(`${label}: ${mode}`, async () => {
          const broken = structuredClone(saved);
          const advice = location === 'decision' ? broken.modelRouting.decisions[0].advice
            : broken.modelRouting.operations['route-1'].response.modelAdvice;
          damage(advice);
          const bytes = JSON.stringify(broken);
          await writeFile(target, bytes);
          await assert.rejects(store.routeProjectWithModelAdvice('p', request, runtime), /Malformed modelRouting/);
          assert.equal(await readFile(target, 'utf8'), bytes);
          const unchanged = JSON.parse(await readFile(target, 'utf8'));
          assert.equal(unchanged.modelRouting.decisions.length, 1);
          assert.deepEqual(Object.keys(unchanged.modelRouting.operations), ['route-1']);
        });
      }
    }
  });
}

for (const receiverCanResolveReferences of [true, false]) {
  test(`historical hold keeps unavailable trigger through deferral preference and choice (references ${receiverCanResolveReferences})`, async t => {
    const { store, args, runtime, trigger, target } = await heldRoute(t);
    await store.transact('p', project => {
      project.modelRouting.decisions[0].advice.hold.futureHoldField = { keep: true };
      project.modelRouting.operations['route-1'].response.modelAdvice.hold.futureHoldField = { keep: true };
      project.plans = [];
      project.observations.push({ id: 'trigger-unavailable', observation: 'Trigger is no longer available' });
    });
    const historical = (await store.getProject('p')).modelRouting.decisions[0];
    const replayBytes = await readFile(target);
    assert.equal((await store.routeProjectWithModelAdvice('p', args, runtime)).replayed, true);
    assert.deepEqual(await readFile(target), replayBytes);
    const steps = [
      { preference: 'auto', forbidden: [], action: 'DEFER_ESCALATION', policy: 'DEFER_ESCALATION' },
      { preference: 'astra', forbidden: [], action: 'REQUEST_USER_CHOICE', policy: 'KEEP_ASTRA' },
      { preference: 'astra', forbidden: ['gpt-6-astra'], action: 'REQUEST_USER_CHOICE', policy: 'REQUEST_USER_CHOICE' },
      { preference: 'auto', forbidden: [], action: 'DEFER_ESCALATION', policy: 'DEFER_ESCALATION' },
    ];
    for (const [index, step] of steps.entries()) {
      const project = await store.getProject('p');
      const request = { ...args.modelRouting, operationId: `continue-${index}`,
        expectedState: getStateIdentity(project), benefit: null, receiverCanResolveReferences,
        userPreference: step.preference, forbiddenModels: step.forbidden };
      const response = await store.routeProjectWithModelAdvice('p', { modelRouting: request }, runtime);
      assert.equal(response.modelAdvice.action, step.action);
      assert.equal(response.modelAdvice.policyAction, step.policy);
      assert.equal(response.modelAdvice.hold, null);
      assert.equal(response.modelAdvice.reasonCodes.includes('hold_requires_revalidation'), true);
      const handoff = response.modelHandoff;
      assert.equal(handoff.incomplete, true);
      assert.equal(handoff.nextAction, 'resync');
      assert.deepEqual(handoff.resync.fullContext, { projectId: 'p', detail: 'full' });
      assert.deepEqual(handoff.identity, response.identity);
      const entry = handoff.references.find(item => item.reference.id === trigger.id);
      assert.ok(entry, 'historical trigger status must be retained');
      assert.deepEqual(entry.reference, trigger);
      assert.equal(entry.status, 'not_found');
      assert.equal(Object.hasOwn(entry, 'record'), false);
      if (receiverCanResolveReferences) assert.equal(Object.hasOwn(handoff, 'referenceBodies'), false);
      else {
        const unavailable = handoff.referenceBodies.find(item => item.reference.id === trigger.id);
        assert.deepEqual(unavailable.reference, trigger);
        assert.equal(unavailable.status, 'not_found');
        assert.equal(Object.hasOwn(unavailable, 'record'), false);
        assert.equal(handoff.referenceBodies.some(item => item.record?.id === 'goal-root'), true);
      }
      assert.deepEqual((await store.getProject('p')).modelRouting.decisions[0], historical);
    }
    const { buildModelHandoff } = await import('../server/model-routing-state.mjs');
    const currentProject = await store.getProject('p');
    for (const scope of [{ workUnitId: 'other-work' }, { sourceIdentity: 'source:other' }]) {
      const request = { ...args.modelRouting, ...scope, benefit: null,
        expectedState: getStateIdentity(currentProject), operationId: 'different-scope' };
      const advice = recommendModel(buildModelRoutingSnapshot(currentProject, request), request, runtime);
      const handoff = buildModelHandoff(currentProject, advice, request);
      assert.equal(handoff.references.some(item => item.reference.id === trigger.id), false);
    }
  });
}

test('stored v1 preserves valid unknown fields and stale historical references', async t => {
  const { store, args, runtime, trigger, target } = await heldRoute(t);
  await store.transact('p', project => {
    project.plans[0].action = 'Inspect the changed dependency contract';
    for (const advice of [project.modelRouting.decisions[0].advice,
      project.modelRouting.operations['route-1'].response.modelAdvice]) {
      advice.futureAdvice = { keep: true };
      advice.hold.futureHold = 'keep';
      advice.evidenceRefs[0].futureRef = 'keep';
    }
  });
  const before = await store.getProject('p');
  const bytes = await readFile(target);
  const replay = await store.routeProjectWithModelAdvice('p', args, runtime);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.modelAdvice.futureAdvice, { keep: true });
  assert.deepEqual(await readFile(target), bytes);
  const response = await store.routeProjectWithModelAdvice('p', { modelRouting: {
    ...args.modelRouting, benefit: null, receiverCanResolveReferences: false,
    expectedState: getStateIdentity(before), operationId: 'current-trigger',
  } }, runtime);
  const stale = response.modelHandoff.references.find(entry => entry.reference.kind === 'plan'
    && entry.reference.revision === trigger.revision);
  assert.equal(stale.status, 'stale');
  assert.deepEqual(stale.reference, trigger);
  assert.equal(stale.currentRef.revision, before.plans[0].revision);
  const body = response.modelHandoff.referenceBodies.find(entry => entry.status === 'stale');
  assert.equal(Object.hasOwn(body, 'record'), false);
  assert.equal(body.currentRecord.action, 'Inspect the changed dependency contract');
  assert.equal(response.modelHandoff.incomplete, true);
  assert.ok(response.modelHandoff.resync);
  const after = await store.getProject('p');
  assert.deepEqual(after.modelRouting.decisions[0], before.modelRouting.decisions[0]);
  assert.deepEqual(after.modelRouting.operations['route-1'], before.modelRouting.operations['route-1']);
});

test('routing conflicts carry detached current identities without writing', async t => {
  const { store, args, runtime, target } = await setup(t);
  await store.addObservation('p', { observation: 'Advance current state' });
  const current = getStateIdentity(await store.getProject('p'));
  const bytes = await readFile(target);
  for (const [patch, code] of [[{ epoch: 'old-epoch' }, 'STATE_EPOCH_CONFLICT'],
    [{ revision: 0 }, 'REVISION_CONFLICT'], [{ revision: 99 }, 'REVISION_CONFLICT']]) {
    const request = { ...args.modelRouting, expectedState: { ...current, ...patch } };
    await assert.rejects(store.routeProjectWithModelAdvice('p', { modelRouting: request }, runtime), error => {
      assert.equal(error.code, code);
      assert.deepEqual(error.identity, current);
      assert.notStrictEqual(error.identity, request.expectedState);
      error.identity.epoch = 'caller mutation';
      error.identity.revision = 500;
      return true;
    });
    assert.deepEqual(await readFile(target), bytes);
    assert.deepEqual(getStateIdentity(await store.getProject('p')), current);
  }
});

test('historical replay keeps its identity and policy after a newer observation', async t => {
  const { store, args, runtime, target } = await setup(t);
  const first = await store.routeProjectWithModelAdvice('p', args, runtime);
  const observation = await store.addObservation('p', { observation: 'new evidence after lost response' });
  const bytes = await readFile(target);
  const denied = createAdvisoryHostAdapter(readModelEligibility({ ASTRA_REQUIRED_MODEL: 'unknown' })).describe();
  const replay = await store.routeProjectWithModelAdvice('p', args, denied);
  assert.deepEqual(replay, { ...first, replayed: true });
  assert.equal(replay.identity.revision, 2);
  assert.equal(observation.revision, 3);
  assert.deepEqual(await readFile(target), bytes);
  const project = await store.getProject('p');
  assert.equal(project.observations[0].observation, 'new evidence after lost response');
  assert.equal(project.modelRouting.decisions.length, 1);
});

test('latest child revision predicts the persisted routing identity', async t => {
  const { store, args, runtime, target } = await setup(t);
  const raw = JSON.parse(await readFile(target, 'utf8'));
  raw.observations.push({ id: 'newer-child', observation: 'legacy child stamp', revision: 40 });
  await writeFile(target, JSON.stringify(raw));
  const response = await store.routeProjectWithModelAdvice('p', args, runtime);
  assert.equal(response.identity.revision, 41);
  assert.equal((await store.getProject('p')).revision, 41);
  assert.equal((await store.getProject('p')).modelRouting.decisions[0].revision, 41);
});

test('optimistic legacy success flags cannot establish completion; negative reports only block it', async t => {
  const { store, args, runtime, target } = await setup(t);
  const optimistic = { ...args, successCriteriaSatisfied: true, evidenceSufficient: true,
    contradictionRemaining: false, meaningfulRiskRemaining: false };
  const first = await store.routeProjectWithModelAdvice('p', optimistic, runtime);
  assert.notEqual(first.modelAdvice.policyAction, 'COMPLETE');
  assert.equal(first.route.completionRecommended, false);
  assert.equal(first.route.wasteReasons.includes('success_verified'), false);
  assert.notEqual(first.route.reasoningRecommendation.reason, 'success_verified');

  const fixture = routingFixture();
  supportAllCriteria(fixture.project);
  const normalized = { ...JSON.parse(await readFile(target, 'utf8')), ...fixture.project, goal: 'Synthetic verification' };
  normalized.projectId = 'p';
  normalized.coordination.epoch = args.modelRouting.expectedState.epoch;
  delete normalized.modelRouting;
  await writeFile(target, JSON.stringify(normalized));
  const completeArgs = { ...optimistic, modelRouting: { ...fixture.request, expectedState: getStateIdentity(normalized) } };
  const bytes = await readFile(target);
  for (const negative of [{ importantUncertainty: true }, { contradictionRemaining: true },
    { meaningfulRiskRemaining: true }, { unmetSuccessCriteria: ['external regression'] }]) {
    await writeFile(target, bytes);
    const blocked = await store.routeProjectWithModelAdvice('p', { ...completeArgs, ...negative }, runtime);
    assert.notEqual(blocked.modelAdvice.policyAction, 'COMPLETE');
    assert.equal(blocked.route.completionRecommended, false);
    assert.equal(blocked.route.wasteReasons.includes('success_verified'), false);
  }
  await writeFile(target, bytes);
  const complete = await store.routeProjectWithModelAdvice('p', completeArgs, runtime);
  assert.equal(complete.modelAdvice.policyAction, 'COMPLETE');
  assert.equal(complete.route.completionRecommended, true);
});

test('unavailable request references prevent persisted completion and require handoff resync', async t => {
  const { store, args, runtime, target } = await setup(t);
  const fixture = supportFixture();
  const raw = { ...JSON.parse(await readFile(target, 'utf8')), ...fixture.project,
    projectId: 'p', goal: 'Synthetic completion with missing reference' };
  raw.coordination.epoch = args.modelRouting.expectedState.epoch;
  const savedBytes = JSON.stringify(raw);
  const validRef = { projectId: 'p', epoch: raw.coordination.epoch, kind: 'evidence',
    id: raw.efficiency.evidenceCache[0].key, revision: 1 };
  for (const ref of [{ ...validRef, id: 'missing' }, { ...validRef, revision: 0 }, { ...validRef, projectId: 'other' }]) {
    await writeFile(target, savedBytes);
    const request = { ...args.modelRouting, benefit: { kind: 'dependency_risk',
      reason: 'Resolve the missing dependency check', refs: [ref] } };
    const result = await store.routeProjectWithModelAdvice('p', { ...args, modelRouting: request }, runtime);
    assert.notEqual(result.modelAdvice.policyAction, 'COMPLETE');
    assert.equal(result.route.completionRecommended, false);
    assert.equal(result.modelHandoff.incomplete, true);
    assert.ok(result.modelHandoff.resync);
    assert.equal(result.modelHandoff.nextAction, 'resync');
  }
});

test('complete caller args cannot replace the server-owned Sol policy descriptor', async t => {
  const { store, args, target } = await setup(t);
  const runtime = createAdvisoryHostAdapter(readModelEligibility({})).describe();
  args.modelRouting.userPreference = 'astra';
  args.hostCapabilities = { eligibility: { allowedModels: ['gpt-6-astra'] } };
  args.runtime = { eligibility: { allowedModels: ['gpt-6-astra'] } };
  const result = await store.routeProjectWithModelAdvice('p', args, runtime);
  assert.equal(result.modelAdvice.action, 'REQUEST_USER_CHOICE');
  assert.equal(result.modelAdvice.recommendedModel, null);
  assert.equal(result.modelAdvice.reasonCodes.includes('preference_ineligible'), true);
  assert.equal(result.modelHandoff.observedModel, null);
  const saved = JSON.parse(await readFile(target, 'utf8'));
  assert.equal(saved.modelRouting.decisions[0].advice.recommendedModel, null);
});

test('handoff preserves older constraints and counter-evidence with body fallback', async () => {
  const { buildModelHandoff } = await import('../server/model-routing-state.mjs');
  const fixture = addDependencyRisk(addFailure(routingFixture()));
  fixture.project.constraints = ['Preserve exact legal text'];
  fixture.project.goalGraph[0].constraints = ['No dropped checks'];
  fixture.project.claims.push({ id: 'claim-1', revision: 1, statement: 'Parser is safe', status: 'contradicted',
    evidenceIds: [], counterEvidenceIds: ['check-1'] });
  fixture.request.receiverCanResolveReferences = false;
  const advice = recommendModel(buildModelRoutingSnapshot(fixture.project, fixture.request), fixture.request, fixture.runtime);
  const bytes = JSON.stringify(fixture);
  const capsule = buildModelHandoff(fixture.project, advice, fixture.request);
  assert.deepEqual(capsule.constraints, ['Preserve exact legal text', 'No dropped checks']);
  assert.equal(capsule.claims[0].counterEvidenceRefs[0].kind, 'evidence');
  assert.equal(capsule.contradictions.some(item => item.claimId === 'claim-1'), true);
  assert.equal(capsule.failedStrategies[0].strategyKey, 'same-strategy');
  assert.equal(capsule.risk.length > 0, true);
  assert.equal(capsule.unmetCriteria.length > 0, true);
  assert.equal(capsule.requiredVerification.length > 0, true);
  assert.equal(capsule.referenceBodies.some(entry => entry.record?.evidenceId === 'check-1'), true);
  assert.equal(capsule.currentModel.source, 'reported');
  assert.equal(capsule.recommendedModel.source, 'advisory');
  assert.equal(capsule.observedModel, null);
  assert.equal(JSON.stringify(fixture), bytes);
});

test('missing stale and cross-project handoff refs demand resync and retain current evidence', async () => {
  const { buildModelHandoff } = await import('../server/model-routing-state.mjs');
  const { project, request, runtime } = supportFixture();
  const advice = recommendModel(buildModelRoutingSnapshot(project, request), request, runtime);
  const key = project.efficiency.evidenceCache[0].key;
  const oldRef = routingRef('evidence', key);
  project.efficiency.evidenceCache[0].result = { synthetic: true, changed: true };
  project.efficiency.evidenceCache[0].revision = 2;
  for (const badRef of [oldRef, routingRef('evidence', 'missing'), { ...oldRef, projectId: 'other' }]) {
    const handoff = buildModelHandoff(project, { ...advice, evidenceRefs: [badRef] }, request);
    assert.equal(handoff.incomplete, true);
    assert.match(handoff.resumeInstructions, /resync|current references|full context/i);
    assert.ok(handoff.resync);
    assert.equal(handoff.references.some(entry => ['stale', 'not_found', 'scope_mismatch'].includes(entry.status)), true);
    assert.equal(handoff.refs.some(ref => ref.id === key && ref.revision === 2), true);
  }
});

function supportFixture() {
  const fixture = routingFixture(); supportAllCriteria(fixture.project); return fixture;
}

test('model change preserves source evidence and advice adds no execution counters', async t => {
  const { store, args, runtime, target } = await setup(t);
  await store.upsertEvidenceRecord('p', { evidenceId: 'check', kind: 'test', target: 'unit',
    dependencies: ['source:v1'], dependencyIds: ['source'], freshness: 'fresh', result: { synthetic: true } });
  const before = await store.getProject('p');
  args.modelRouting.expectedState = getStateIdentity(before);
  args.modelRouting.userPreference = 'astra';
  const result = await store.routeProjectWithModelAdvice('p', args, runtime);
  const after = JSON.parse(await readFile(target, 'utf8'));
  assert.equal(result.modelAdvice.action, 'REQUEST_USER_CHOICE');
  assert.ok(result.modelHandoff);
  assert.deepEqual(after.efficiency.evidenceCache, before.efficiency.evidenceCache);
  assert.deepEqual(after.efficiency.ledger, before.efficiency.ledger);
  assert.equal(result.modelAdvice.observedModel, null);
});

function worker(t, root, args, runtime, fail = false) {
  const child = fork(new URL('./helpers/model-routing-worker.mjs', import.meta.url), [root],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const ready = once(child, 'message');
  const exited = once(child, 'exit');
  return { async run() {
    await ready;
    const response = once(child, 'message');
    child.send({ args, runtime, fail });
    const [message] = await response;
    const [code] = await exited;
    assert.equal(code, 0, stderr);
    return message;
  } };
}

for (const sameOperation of [true, false]) {
  test(`two workers ${sameOperation ? 'replay the same operation' : 'conflict on different operations'} without duplicates`, async t => {
    const { store, root, args, runtime } = await setup(t);
    const query = { kind: 'test', target: 'concurrent cache', dependencies: ['source:v1'] };
    await store.upsertEvidenceRecord('p', { ...query, evidenceId: 'cache-check', dependencyIds: ['source'],
      freshness: 'fresh', result: { synthetic: true } });
    args.cacheRequest = query;
    args.modelRouting.expectedState = getStateIdentity(await store.getProject('p'));
    const secondArgs = structuredClone(args);
    if (!sameOperation) secondArgs.modelRouting.operationId = 'route-2';
    const writers = [worker(t, root, args, runtime), worker(t, root, secondArgs, runtime)];
    const results = await Promise.all(writers.map(writer => writer.run()));
    assert.equal(results.filter(item => item.response?.replayed === false).length, 1);
    if (sameOperation) assert.equal(results.filter(item => item.response?.replayed === true).length, 1);
    else assert.equal(results.filter(item => item.error?.code === 'REVISION_CONFLICT').length, 1);
    const saved = await store.getProject('p');
    assert.equal(saved.revision, 3);
    assert.equal(saved.modelRouting.decisions.length, 1);
    assert.equal(Object.keys(saved.modelRouting.operations).length, 1);
    assert.equal(saved.efficiency.ledger.events.length, 1);
    assert.equal(saved.efficiency.ledger.events[0].type, 'reusedEvidence');
  });
}

test('failed atomic publish leaves the old snapshot usable and no abandoned temporary file', async t => {
  const { store, root, args, runtime, target } = await setup(t);
  const bytes = await readFile(target);
  const result = await worker(t, root, args, runtime, true).run();
  assert.match(result.error.message, /injected rename failure/);
  assert.deepEqual(result.injection, { ownedTemporaryFile: true, decisions: 1 });
  assert.deepEqual(await readFile(target), bytes);
  assert.deepEqual(await readdir(root), [path.basename(target)]);
  assert.equal((await store.getProject('p')).revision, 1);
  assert.equal((await store.routeProjectWithModelAdvice('p', args, runtime)).identity.revision, 2);
});
