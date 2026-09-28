import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProjectStore } from '../server/state-store.mjs';

const dir = await mkdtemp(path.resolve('.task-7-test-'));
process.env.ASTRA_PROJECT_FORGE_DATA_DIR = dir;
const { dispatch, processRpcMessage } = await import('../server/mcp-server.mjs');
const store = new ProjectStore(dir);
test.after(() => rm(dir, { recursive: true, force: true }));
const call = (name, args = {}) => dispatch({ method: 'tools/call', params: { name, arguments: args } });
const ok = result => {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return result.structuredContent;
};
const error = (result, pattern) => {
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.match(result.content[0].text, pattern);
};
async function init(projectId) {
  ok(await call('adaptive_initialize_project', { projectId, goal: 'Verify integration', successCriteria: ['tests pass'] }));
  return projectId;
}

test('JSONRPC lists exactly the compatible 19 names and optional efficiency fields', async () => {
  const response = await processRpcMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(response.id, 1);
  assert.deepEqual(response.result.tools.map(tool => tool.name).sort(), [
    'forge_route', 'forge_goal', 'forge_context', 'forge_observe', 'forge_plan',
    'forge_evaluate', 'forge_adapt', 'forge_checkpoint', 'forge_consolidate',
    'adaptive_route_task', 'adaptive_get_context', 'adaptive_initialize_project',
    'adaptive_get_state', 'adaptive_list_projects', 'adaptive_record_observation',
    'adaptive_record_hypothesis', 'adaptive_record_experiment', 'adaptive_checkpoint',
    'adaptive_consolidate',
  ].sort());
  const routeTool = response.result.tools.find(tool => tool.name === 'forge_route');
  assert.equal(routeTool.annotations.idempotentHint, false, 'routing can advance guidance and record observed cache retrieval');
  const schema = routeTool.inputSchema;
  assert.ok(schema.properties.efficiencyPolicy);
  assert.deepEqual(schema.required, ['complexity']);
});

test('route uses persisted policy after restart and an explicit override stays local', async () => {
  const projectId = await init('policy');
  ok(await call('forge_adapt', { projectId, operation: 'set_efficiency_policy', efficiencyPolicy: 'eco' }));
  assert.equal((await new ProjectStore(dir).getProject(projectId)).efficiency.policy, 'eco');
  const args = { projectId, complexity: 'complex', uncertainty: 'high', completedCycles: 2, candidateWouldProduceNewEvidence: true };
  const { route, noticeRequired, deepNoticeRequired } = ok(await call('forge_route', args));
  assert.equal(route.efficiencyPolicy, 'eco');
  assert.equal(route.softCycleBudget, 2);
  assert.equal(route.requiresJustification, true);
  assert.equal(route.efficiencyDecision, 'allow');
  assert.equal(noticeRequired, true);
  assert.equal(deepNoticeRequired, true);
  const override = ok(await call('forge_route', { ...args, efficiencyPolicy: 'maximum' })).route;
  assert.equal(override.softCycleBudget, 6);
  assert.equal(override.requiresJustification, false);
  assert.equal((await store.getProject(projectId)).efficiency.policy, 'eco');
  ok(await call('forge_adapt', { projectId, operation: 'acknowledge_usage', firstUseNoticeAcknowledged: true, deepWarningAcknowledged: true }));
  const acknowledged = ok(await call('forge_route', args));
  assert.equal(acknowledged.noticeRequired, false);
  assert.equal(acknowledged.deepNoticeRequired, false);
});

test('route applies utility and completion without inventing execution events', async () => {
  const projectId = await init('utility');
  const before = (await store.getProject(projectId)).efficiency.ledger;
  for (const [signals, decision] of [
    [{ candidateWouldVerifySuccessCriterion: true, completedCycles: 3 }, 'allow'],
    [{ completedCycles: 3 }, 'justify'],
    [{ duplicateValidEvidence: true }, 'skip'],
    [{ duplicateValidEvidence: true, candidateHasIndependentValue: true, candidateWouldDetectFailure: true }, 'allow'],
    [{ successCriteriaSatisfied: true, evidenceSufficient: true, contradictionRemaining: false, meaningfulRiskRemaining: false }, 'stop'],
  ]) {
    const route = ok(await call('forge_route', { projectId, complexity: 'complex', uncertainty: 'high', ...signals })).route;
    assert.equal(route.efficiencyDecision, decision);
  }
  assert.deepEqual((await store.getProject(projectId)).efficiency.ledger, before);
});

test('route persists reasoning recommendations and both hysteresis directions', async () => {
  const projectId = await init('hysteresis');
  const route = async signals => ok(await call('forge_route', { projectId, complexity: 'complex', ...signals })).route;
  assert.equal((await route({ unresolvedCycles: 1 })).reasoningRecommendation.level, 'medium');
  assert.equal((await route({ importantUncertainty: false, highRisk: false })).reasoningRecommendation.reason, 'hysteresis_hold');
  assert.equal((await route({ importantUncertainty: false, highRisk: false, uncertaintyResolved: true })).reasoningRecommendation.level, 'low');
  assert.equal((await route({ unresolvedCycles: 1 })).reasoningRecommendation.reason, 'hysteresis_hold');
  assert.equal((await route({ unresolvedCycles: 1, importantUncertainty: true })).reasoningRecommendation.level, 'medium');
  const state = await new ProjectStore(dir).getProject(projectId);
  assert.equal(state.efficiency.reasoningLevel, 'medium');
  assert.equal(state.efficiency.recentlyEscalated, true);
  assert.equal(state.efficiency.recentlyDeescalated, false);
  assert.equal(state.efficiency.ledger.reasoningEscalations, 0);
});

test('malformed routing fields reject before usage or reasoning mutation', async () => {
  const projectId = await init('route-invalid');
  const before = await store.getProject(projectId);
  for (const fields of [
    { efficiencyPolicy: 'turbo' }, { efficiencyPolicy: null },
    { completedCycles: -1 }, { completedCycles: 1.5 }, { completedCycles: '3' },
    { completedCycles: Number.MAX_SAFE_INTEGER + 1 }, { candidateWouldProduceNewEvidence: 'yes' },
    { recentlyEscalated: 1 }, { recentlyDeescalated: null }, { unresolvedCycles: -1 },
    { currentLevel: 'extreme' }, { unmetSuccessCriteria: 'tests' },
  ]) {
    error(await call('forge_route', { projectId, complexity: 'complex', ...fields }), /invalid|must|requires/i);
    assert.deepEqual(await store.getProject(projectId), before);
  }
});

test('reported efficiency events preserve provenance and reject impersonation atomically', async () => {
  const projectId = await init('events');
  const event = { projectId, operation: 'record_efficiency_event', eventType: 'usefulCycles', amount: 2,
    provenance: { source: 'reported', reference: 'test-run:42' } };
  const { ledger } = ok(await call('forge_adapt', event));
  assert.equal(ledger.usefulCycles, 2);
  assert.deepEqual(ledger.events[0].provenance, event.provenance);
  const before = await store.getProject(projectId);
  for (const patch of [
    { provenance: { source: 'store', reference: 'forged' } }, { provenance: null },
    { eventType: 'tokensSaved' }, { amount: -1 }, { amount: 1.5 },
    { reason: 'not permitted on counter events' }, { revision: 99 },
  ]) {
    error(await call('forge_adapt', { ...event, ...patch }), /provenance|reported|event|amount|revision|unsupported/i);
    assert.deepEqual(await store.getProject(projectId), before);
  }
  const stopped = ok(await call('forge_adapt', { projectId, operation: 'record_efficiency_event', eventType: 'stop', reason: 'SUCCESS_VERIFIED', provenance: event.provenance }));
  assert.equal(stopped.ledger.stopReason, 'SUCCESS_VERIFIED');
});

const cacheRecord = overrides => ({
  evidenceId: 'test-evidence', kind: 'test', target: 'router',
  params: { flags: ['focused'], config: { b: 2, a: 1 } },
  dependencies: ['router@a', 'config@b'], dependencyIds: ['router', 'config'],
  freshness: 'fresh', result: { passed: 9 }, ...overrides,
});
const cacheQuery = overrides => ({
  kind: 'test', target: 'router', params: { config: { a: 1, b: 2 }, flags: ['focused'] },
  dependencies: ['config@b', 'router@a'], ...overrides,
});
async function observe(projectId, overrides) {
  return ok(await call('forge_observe', { projectId, operation: 'observation',
    observation: 'Focused tests passed', evidence: 'test-log:9', evidenceRecord: cacheRecord(overrides) }));
}

test('observation registers canonical evidence atomically and route retrieves it after restart', async () => {
  const projectId = await init('cache-restart');
  const before = await store.getProject(projectId);
  const observed = await observe(projectId);
  assert.ok(observed.evidenceRecord, 'observation must register reusable evidence');
  assert.equal(observed.evidenceRecord.observationId, observed.observation.id);
  assert.equal(observed.evidenceRecord.revision, observed.observation.revision);
  assert.equal((await store.getProject(projectId)).revision, before.revision + 1);
  assert.equal((await new ProjectStore(dir).findReusableEvidence(projectId, cacheQuery())).evidenceId, 'test-evidence');
  const response = await processRpcMessage({ jsonrpc: '2.0', id: 'reuse', method: 'tools/call', params: {
    name: 'forge_route', arguments: { projectId, complexity: 'complex', cacheRequest: cacheQuery() },
  } });
  assert.equal(response.id, 'reuse');
  const result = ok(response.result);
  assert.deepEqual(result.evidenceRecord.result, { passed: 9 });
  assert.equal(result.route.efficiencyDecision, 'reuse');
  const state = await store.getProject(projectId);
  assert.equal(state.efficiency.ledger.reusedEvidence, 1);
  assert.deepEqual(state.efficiency.ledger.events[0].provenance, {
    source: 'store', reference: `reuseEvidence:${observed.evidenceRecord.key}`,
  });
  assert.equal(state.efficiency.ledger.usefulCycles, 0);
  assert.equal(state.efficiency.ledger.duplicateToolCallsAvoided, 0);
});

test('malformed observation cache metadata never leaves a partial observation', async () => {
  const projectId = await init('cache-atomic');
  const before = await store.getProject(projectId);
  for (const evidenceRecord of [
    null, [], {}, cacheRecord({ evidenceId: '' }), cacheRecord({ dependencies: undefined }),
    cacheRecord({ dependencyIds: [] }), cacheRecord({ freshness: 'maybe' }),
    cacheRecord({ key: 'forged' }), cacheRecord({ dependencyFingerprint: 'forged' }),
    cacheRecord({ params: { unsupported: undefined } }),
  ]) {
    error(await call('forge_observe', { projectId, operation: 'observation', observation: 'must not persist', evidenceRecord }), /evidence|depend|freshness|params|kind|json|object/i);
    assert.deepEqual(await store.getProject(projectId), before);
  }
  error(await call('forge_observe', { projectId, operation: 'claim', statement: 'A claim', evidenceRecord: cacheRecord() }), /observation/i);
  assert.deepEqual(await store.getProject(projectId), before);
  error(await call('forge_observe', { projectId, operation: 'observation', observation: '', evidenceRecord: cacheRecord() }), /observation/);
  assert.deepEqual(await store.getProject(projectId), before);
});

test('cache freshness and changed identities control actual reuse with a risk floor', async () => {
  const projectId = await init('cache-validity');
  const route = async (query, fields = {}) => ok(await call('forge_route', { projectId, complexity: 'complex', cacheRequest: query, ...fields }));
  for (const [freshness, risk, reusable] of [
    ['fresh', 'high', true], ['probably_fresh', 'low', true],
    ['probably_fresh', 'high', false], ['stale', 'low', false], ['invalidated', 'low', false],
  ]) {
    await observe(projectId, { freshness });
    const result = await route(cacheQuery({ risk }));
    assert.equal(Boolean(result.evidenceRecord), reusable, `${freshness}/${risk}`);
  }
  await observe(projectId, { freshness: 'probably_fresh' });
  assert.equal((await route(cacheQuery({ risk: 'low' }), { risk: 'high' })).evidenceRecord, null);
  await observe(projectId);
  for (const query of [cacheQuery({ params: {} }), cacheQuery({ dependencies: ['router@changed', 'config@b'] }), cacheQuery({ target: 'other' })]) {
    assert.equal((await route(query)).evidenceRecord, null);
  }
  assert.equal((await store.getProject(projectId)).efficiency.ledger.reusedEvidence, 2);
});

test('facade invalidation is selective and invalid requests cannot mutate routing', async () => {
  const projectId = await init('cache-invalidate');
  await observe(projectId);
  await observe(projectId, { evidenceId: 'independent', target: 'other', dependencies: ['other@a'], dependencyIds: ['other'] });
  const invalidated = ok(await call('forge_adapt', { projectId, operation: 'invalidate_evidence', changedDependencyIds: ['router'] }));
  assert.equal(invalidated.evidenceCache.find(record => record.target === 'router').freshness, 'stale');
  assert.equal(invalidated.evidenceCache.find(record => record.target === 'other').freshness, 'fresh');
  const before = await store.getProject(projectId);
  for (const cacheRequest of [null, {}, cacheQuery({ dependencies: undefined }), cacheQuery({ params: { x: NaN } }), cacheQuery({ risk: 'extreme' })]) {
    error(await call('forge_route', { projectId, complexity: 'complex', cacheRequest }), /evidence|depend|params|kind|risk|json|object/i);
    assert.deepEqual(await store.getProject(projectId), before);
  }
  error(await call('forge_route', { complexity: 'complex', cacheRequest: cacheQuery() }), /projectId/);
  for (const changedDependencyIds of [undefined, 'router', [null]]) {
    error(await call('forge_adapt', { projectId, operation: 'invalidate_evidence', changedDependencyIds }), /depend/i);
    assert.deepEqual(await store.getProject(projectId), before);
  }
});

test('context defaults retain old envelopes and progressive summaries preserve stable decision state', async () => {
  const projectId = await init('context-summary');
  const known = ok(await call('forge_observe', { projectId, operation: 'claim', statement: 'Tests passed', claimStatus: 'known', evidenceIds: ['log'] })).claim;
  const contradiction = ok(await call('forge_observe', { projectId, operation: 'claim', statement: 'Conflicting result', claimStatus: 'contradicted', evidenceIds: ['log'], counterEvidenceIds: ['counter-log'] })).claim;
  await observe(projectId);
  const state = await store.getProject(projectId);
  const legacy = ok(await call('forge_context', { projectId })).context;
  assert.deepEqual(Object.keys(legacy).sort(), ['detail', 'project', 'counts', 'latestCheckpoint', 'recentLessons', 'usage', 'consolidation'].sort());
  assert.deepEqual(ok(await call('forge_context', { projectId, detail: 'full' })).context, { project: state });
  assert.ok(ok(await call('forge_context', { projectId, detail: 'recovery' })).recovery);
  const summary = ok(await call('forge_context', { projectId, resultLevel: 'summary' })).context;
  assert.equal(summary.revision, state.revision);
  assert.equal(summary.resultLevel, 'summary');
  assert.ok(summary.stableFacts.some(claim => claim.id === known.id));
  assert.ok(summary.unresolvedClaims.some(claim => claim.id === contradiction.id));
  assert.ok(summary.activeGoals.some(goal => goal.id === 'goal-root'));
  assert.equal(summary.archiveRef.projectId, projectId);
  assert.equal(summary.project.observations, undefined);
  const relevant = ok(await call('forge_context', { projectId, detail: 'working', resultLevel: 'relevant' })).context;
  assert.equal(relevant.efficiency.evidenceCache[0].evidenceId, 'test-evidence');
  assert.deepEqual(await store.getProject(projectId), state, 'context cannot mutate revisions, counters or history');
});

test('context deltas include updates, all changed records and empty groups on unchanged state', async () => {
  const projectId = await init('context-delta');
  const claim = ok(await call('forge_observe', { projectId, operation: 'claim', statement: 'Need verification', claimStatus: 'unknown' })).claim;
  const before = await store.getProject(projectId);
  ok(await call('forge_observe', { projectId, operation: 'update_claim', claimId: claim.id, claimStatus: 'known', evidenceIds: ['verified'] }));
  for (let index = 0; index < 3; index++) {
    ok(await call('forge_observe', { projectId, operation: 'observation', observation: `Change ${index}` }));
  }
  await observe(projectId);
  const response = await processRpcMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'forge_context', arguments: { projectId, detail: 'working', resultLevel: 'relevant', sinceRevision: before.revision, maxItems: 1 },
  } });
  const delta = ok(response.result).context;
  assert.ok(delta.changes, 'cursor must return changed-record groups');
  assert.equal(delta.changes.claims[0].status, 'known');
  assert.equal(delta.changes.claims[0].id, claim.id);
  assert.equal(delta.changes.goalGraph.length, 0);
  assert.equal(delta.changes.observations.length, 4, 'maxItems cannot drop cursor records');
  assert.equal(delta.changes.evidenceCache.length, 1);
  const state = await store.getProject(projectId);
  for (const resultLevel of ['summary', 'relevant']) {
    const empty = await new ProjectStore(dir).getContext(projectId, { sinceRevision: state.revision, resultLevel });
    assert.equal(empty.revision, state.revision);
    assert.ok(Object.values(empty.changes).every(records => records.length === 0));
    assert.ok(empty.stableFacts.some(record => record.id === claim.id));
  }
  assert.deepEqual(await store.getProject(projectId), state);
});

test('context full recovery returns raw history and contradictory detail/cursor combinations reject', async () => {
  const projectId = await init('context-recovery');
  ok(await call('forge_checkpoint', { projectId, summary: 'Resume here', nextSteps: ['Verify full state'] }));
  const state = await store.getProject(projectId);
  for (const detail of ['summary', 'working', 'full', 'recovery']) {
    const full = ok(await call('forge_context', { projectId, detail, resultLevel: 'full' })).context;
    assert.equal(full.resultLevel, 'full');
    assert.equal(full.revision, state.revision);
    assert.deepEqual(full.project, state);
  }
  for (const options of [
    { detail: 'full', sinceRevision: 0 }, { detail: 'recovery', sinceRevision: 0 },
    { resultLevel: 'full', sinceRevision: 0 }, { detail: 'full', resultLevel: 'summary' },
    { detail: 'recovery', resultLevel: 'relevant' },
  ]) {
    error(await call('forge_context', { projectId, ...options }), /full|recovery|sinceRevision/i);
    await assert.rejects(store.getContext(projectId, options), /full|recovery|sinceRevision/i);
  }
  assert.deepEqual(await store.getProject(projectId), state);
});

test('context rejects malformed options and future cursors without persistent side effects', async () => {
  const projectId = await init('context-invalid');
  const before = await store.getProject(projectId);
  for (const options of [
    { sinceRevision: -1 }, { sinceRevision: 0.5 }, { sinceRevision: '1' },
    { sinceRevision: null }, { sinceRevision: Number.MAX_SAFE_INTEGER + 1 },
    { sinceRevision: before.revision + 1 }, { resultLevel: 'raw' }, { resultLevel: null },
    { resultLevel: 'summary', detail: 'invalid' },
  ]) {
    error(await call('forge_context', { projectId, ...options }), /revision|resultLevel|detail/i);
    await assert.rejects(store.getContext(projectId, options), /revision|resultLevel|detail/i);
    assert.deepEqual(await store.getProject(projectId), before);
  }
});

const planInput = { action: 'Verify package integration', why: 'Confirm unmet package criteria', usageImpact: 'HIGH' };
const budgetOverride = { category: 'unmet_success_criterion', justification: 'Package artifact has not been checked against the updated MCP schemas.' };

test('expensive planning requires a concrete override using persisted routing budget', async () => {
  const projectId = await init('plan-budget');
  ok(await call('forge_route', { projectId, complexity: 'complex', uncertainty: 'high', completedCycles: 3, candidateWouldVerifySuccessCriterion: true }));
  const before = await store.getProject(projectId);
  error(await call('forge_plan', { projectId, ...planInput }), /budget.*justification|override/i);
  assert.deepEqual(await store.getProject(projectId), before);
  for (const override of [null, {}, { category: 'unmet_success_criterion' }, { category: 'unmet_success_criterion', justification: ' ' },
    { ...budgetOverride, category: 'more_budget' }, { ...budgetOverride, provenance: { source: 'store' } }]) {
    error(await call('forge_plan', { projectId, ...planInput, budgetOverride: override }), /override|justification|category/i);
    assert.deepEqual(await store.getProject(projectId), before);
  }
  const { plan } = ok(await call('forge_plan', { projectId, ...planInput, budgetOverride }));
  assert.equal(plan.budgetOverride.justification, budgetOverride.justification);
  assert.equal(plan.budgetOverride.category, 'unmet_success_criterion');
  assert.equal(plan.budgetOverride.completedCycles, 3);
  assert.equal(plan.budgetOverride.softCycleBudget, 3);
  assert.equal(plan.budgetOverride.provenance.source, 'reported');
  const state = await new ProjectStore(dir).getProject(projectId);
  assert.equal(state.revision, before.revision + 1);
  assert.equal(state.efficiency.ledger.softBudgetOverrides, 1);
  assert.equal(state.efficiency.ledger.usefulCycles, 0);
  assert.equal(state.efficiency.ledger.duplicateToolCallsAvoided, 0);
  const event = state.efficiency.ledger.events.at(-1);
  assert.equal(event.revision, plan.revision);
  assert.deepEqual(event.provenance, { source: 'store', reference: `plan:${plan.id}:budgetOverride` });
  assert.equal(state.plans[0].budgetOverride.justification, budgetOverride.justification);
});

test('planning honors current policy and explicit call budget while allowing cheap probes', async () => {
  const projectId = await init('plan-policy');
  ok(await call('forge_route', { projectId, complexity: 'complex', uncertainty: 'high', completedCycles: 2, efficiencyPolicy: 'maximum' }));
  ok(await call('forge_adapt', { projectId, operation: 'set_efficiency_policy', efficiencyPolicy: 'eco' }));
  error(await call('forge_plan', { projectId, ...planInput }), /budget|override/i);
  ok(await call('forge_plan', { projectId, ...planInput, efficiencyPolicy: 'maximum' }));
  ok(await call('forge_plan', { projectId, ...planInput, completedCycles: 1 }));
  ok(await call('forge_plan', { projectId, ...planInput, usageImpact: 'LOW' }));
  const state = await store.getProject(projectId);
  assert.equal(state.efficiency.policy, 'eco');
  assert.equal(state.efficiency.ledger.softBudgetOverrides, 0);
  for (const fields of [{ completedCycles: -1 }, { efficiencyPolicy: 'invalid' }, { completedCycles: null }]) {
    error(await call('forge_plan', { projectId, ...planInput, ...fields }), /invalid|must/i);
    assert.deepEqual(await store.getProject(projectId), state);
  }
});

test('planning reuses matching cache without new work and misses retain risk-weighted plans', async () => {
  const projectId = await init('plan-cache');
  await observe(projectId);
  const before = await store.getProject(projectId);
  const reused = ok(await call('forge_plan', { projectId, ...planInput, completedCycles: 10, cacheRequest: cacheQuery() }));
  assert.equal(reused.plan, null);
  assert.equal(reused.efficiencyDecision, 'reuse');
  assert.equal(reused.evidenceRecord.evidenceId, 'test-evidence');
  const state = await store.getProject(projectId);
  assert.equal(state.plans.length, 0);
  assert.equal(state.revision, before.revision + 1);
  assert.equal(state.efficiency.ledger.reusedEvidence, 1);
  assert.equal(state.efficiency.ledger.softBudgetOverrides, 0);
  assert.equal(state.efficiency.ledger.usefulCycles, 0);
  const miss = ok(await call('forge_plan', { projectId, ...planInput, cacheRequest: cacheQuery({ dependencies: [] }), verificationRisk: 'high' }));
  assert.equal(miss.evidenceRecord, null);
  assert.equal(miss.plan.verificationStrength, 'strong');
  await observe(projectId, { freshness: 'probably_fresh' });
  const refreshed = ok(await call('forge_plan', { projectId, ...planInput, cacheRequest: cacheQuery({ risk: 'low' }), reversible: false }));
  assert.equal(refreshed.evidenceRecord, null);
  assert.equal(refreshed.plan.verificationStrength, 'strong');
});

test('plan validation precedes reuse counters and overrides even for compound failures', async () => {
  const projectId = await init('plan-atomic');
  await observe(projectId);
  const before = await store.getProject(projectId);
  for (const fields of [
    { cacheRequest: null }, { cacheRequest: cacheQuery({ dependencies: undefined }) },
    { cacheRequest: cacheQuery(), verificationRisk: 'invalid' },
    { cacheRequest: cacheQuery(), strategyKey: '' }, { cacheRequest: cacheQuery(), newEvidenceIds: 'log' },
    { cacheRequest: cacheQuery(), changedConditions: 7 }, { cacheRequest: cacheQuery(), action: '' },
    { cacheRequest: cacheQuery(), budgetOverride: {} }, { goalId: 'missing', completedCycles: 10, budgetOverride },
  ]) {
    error(await call('forge_plan', { projectId, ...planInput, ...fields }), /depend|kind|risk|strategy|evidence|condition|action|override|goal|justification|params/i);
    assert.deepEqual(await store.getProject(projectId), before);
  }
});

test('plan and evaluation facade enforce failed-strategy memory and expose risk fields', async () => {
  const projectId = await init('plan-retry');
  const { tools } = await dispatch({ method: 'tools/list' });
  const schema = tools.find(tool => tool.name === 'forge_plan').inputSchema;
  for (const field of ['strategyKey', 'newEvidenceIds', 'changedConditions', 'verificationRisk', 'expectedDecisionImpact', 'cacheRequest', 'budgetOverride', 'completedCycles', 'efficiencyPolicy']) {
    assert.ok(schema.properties[field], `missing ${field}`);
    assert.ok(!schema.required.includes(field));
  }
  const { plan } = ok(await call('forge_plan', { projectId, ...planInput, strategyKey: ' inspect-config ', verificationRisk: 'low', risk: 'high', expectedDecisionImpact: 'high' }));
  assert.equal(plan.verificationStrength, 'strong');
  assert.equal(plan.strategyKey, 'inspect-config');
  const revision = (await store.getProject(projectId)).revision;
  ok(await call('forge_evaluate', { projectId, planId: plan.id, outcome: 'falsified', summary: 'Configuration mismatch', evidenceIds: ['old-log'] }));
  error(await call('forge_plan', { projectId, ...planInput, strategyKey: 'inspect-config', newEvidenceIds: ['old-log'] }), /Failed strategy/);
  const retried = ok(await call('forge_plan', { projectId, ...planInput, strategyKey: 'inspect-config', newEvidenceIds: ['new-log'], changedConditions: 'config@b' })).plan;
  assert.deepEqual(retried.newEvidenceIds, ['new-log']);
  assert.equal(retried.changedConditions, 'config@b');
  const delta = ok(await call('forge_context', { projectId, sinceRevision: revision, resultLevel: 'relevant' })).context;
  assert.equal(delta.changes.failedStrategies.length, 1);
  assert.equal(delta.changes.failedStrategies[0].cause, 'Configuration mismatch');
  assert.equal(delta.changes.evaluations.length, 1);
});

test('routing retains reported budget position when a later request omits completedCycles', async () => {
  const projectId = await init('retained-budget');
  ok(await call('forge_route', { projectId, complexity: 'complex', completedCycles: 3 }));
  const routed = ok(await call('forge_route', { projectId, complexity: 'complex', candidateWouldVerifySuccessCriterion: true }));
  assert.equal(routed.route.requiresJustification, true);
  error(await call('forge_plan', { projectId, ...planInput }), /override|budget/i);
  assert.equal((await store.getProject(projectId)).efficiency.ledger.usefulCycles, 0);
});

test('high-risk routing cannot be weakened by conflicting booleans', async () => {
  const projectId = await init('risk-floor');
  const result = ok(await call('forge_route', { projectId, complexity: 'complex', currentLevel: 'medium',
    risk: 'high', highRisk: false, importantUncertainty: false, unresolvedCycles: 1 }));
  assert.equal(result.route.reasoningRecommendation.level, 'high');
});

test('high-risk routing normalizes legacy risk before cache reuse', async () => {
  const projectId = await init('normalized-risk');
  await observe(projectId, { freshness: 'probably_fresh' });
  const cache = ok(await call('forge_route', { projectId, complexity: 'complex', risk: ' HIGH ', cacheRequest: cacheQuery({ risk: 'low' }) }));
  assert.equal(cache.route.risk, 'high');
  assert.equal(cache.evidenceRecord, null);
  assert.equal((await store.getProject(projectId)).efficiency.ledger.reusedEvidence, 0);
});

test('inapplicable new adapt fields reject before existing usage or policy mutations', async () => {
  const projectId = await init('adapt-validation');
  const before = await store.getProject(projectId);
  for (const fields of [
    { operation: 'acknowledge_usage', firstUseNoticeAcknowledged: true, efficiencyPolicy: 'invalid' },
    { operation: 'acknowledge_usage', firstUseNoticeAcknowledged: true, provenance: { source: 'store' } },
    { operation: 'set_efficiency_policy', efficiencyPolicy: 'eco', changedDependencyIds: 'router' },
    { operation: 'invalidate_evidence', changedDependencyIds: [], amount: 2 },
  ]) {
    error(await call('forge_adapt', { projectId, ...fields }), /field|operation|unsupported|invalid/i);
    assert.deepEqual(await store.getProject(projectId), before);
  }
});

test('default null context options remain compatible', async () => {
  const projectId = await init('null-context');
  assert.deepEqual(await store.getContext(projectId, null), await store.getContext(projectId));
});

test('stdio JSONRPC restart preserves policy, cached results, provenance and delta recovery', async () => {
  const projectId = 'stdio-restart';
  const rpc = operations => {
    const messages = operations.map(([name, args], index) => ({ jsonrpc: '2.0', id: index,
      method: 'tools/call', params: { name, arguments: { projectId, ...args } } }));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../server/mcp-server.mjs', import.meta.url)), '--stdio'], {
      env: { ...process.env, ASTRA_PROJECT_FORGE_DATA_DIR: dir }, encoding: 'utf8',
      input: messages.map(message => JSON.stringify(message)).join('\n') + '\n', timeout: 15000,
    });
    assert.equal(result.status, 0, String(result.error ?? result.stderr));
    assert.equal(result.stderr, '');
    const responses = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(responses.map(response => response.id), messages.map(message => message.id));
    return responses.map(response => ok(response.result));
  };
  const first = rpc([
    ['adaptive_initialize_project', { goal: 'Resume MCP work' }],
    ['forge_adapt', { operation: 'set_efficiency_policy', efficiencyPolicy: 'eco' }],
    ['forge_observe', { operation: 'observation', observation: 'Tests passed', evidenceRecord: cacheRecord() }],
    ['forge_context', { resultLevel: 'summary' }],
  ]);
  const revision = first.at(-1).context.revision;
  const second = rpc([
    ['forge_route', { complexity: 'complex', completedCycles: 2, cacheRequest: cacheQuery() }],
    ['forge_adapt', { operation: 'record_efficiency_event', eventType: 'usefulCycles', amount: 1,
      provenance: { source: 'reported', reference: 'execution:one' } }],
    ['forge_context', { sinceRevision: revision, resultLevel: 'relevant' }],
    ['forge_context', { detail: 'recovery', resultLevel: 'full' }],
  ]);
  assert.equal(second[0].route.efficiencyPolicy, 'eco');
  assert.equal(second[0].route.efficiencyDecision, 'reuse');
  assert.equal(second[0].evidenceRecord.evidenceId, 'test-evidence');
  assert.deepEqual(second[2].context.changes.events.map(event => event.provenance.source), ['store', 'reported']);
  assert.equal(second[2].context.changes.observations.length, 0);
  const full = second[3].context.project;
  assert.equal(full.efficiency.ledger.usefulCycles, 1);
  assert.equal(full.efficiency.ledger.reusedEvidence, 1);
  assert.equal(full.efficiency.ledger.duplicateToolCallsAvoided, 0);
  assert.equal(full.observations.length, 1);
});

test('JSONRPC malformed optional fields return tool errors without partial persistence', async () => {
  const projectId = await init('rpc-errors');
  const before = await store.getProject(projectId);
  const requests = [
    ['forge_route', { complexity: 'complex', completedCycles: -1 }],
    ['forge_observe', { operation: 'observation', observation: 'must not persist', evidenceRecord: {} }],
    ['forge_plan', { ...planInput, budgetOverride: { category: 'important_uncertainty' } }],
    ['forge_adapt', { operation: 'record_efficiency_event', eventType: 'reusedEvidence', provenance: { source: 'store', reference: 'forged' } }],
    ['forge_context', { detail: 'recovery', sinceRevision: 0 }],
  ];
  for (const [name, args] of requests) {
    const response = await processRpcMessage(JSON.parse(JSON.stringify({ jsonrpc: '2.0', id: name,
      method: 'tools/call', params: { name, arguments: { projectId, ...args } } })));
    assert.equal(response.jsonrpc, '2.0');
    assert.equal(response.id, name);
    assert.equal(response.error, undefined);
    error(response.result, /invalid|must|required|provenance|sinceRevision/i);
    assert.deepEqual(await store.getProject(projectId), before);
  }
});
