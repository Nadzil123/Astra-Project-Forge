import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProjectStore, routeWithEfficiency } from '../server/state-store.mjs';

const dir = await mkdtemp(path.join(tmpdir(), 'compact-results-test-'));
process.env.ASTRA_PROJECT_FORGE_DATA_DIR = dir;
const { dispatch } = await import('../server/mcp-server.mjs');
const store = new ProjectStore(dir);
test.after(() => rm(dir, { recursive: true, force: true }));
const selected = ['forge_route', 'forge_plan', 'forge_observe', 'forge_evaluate'];
const call = (name, args = {}) => dispatch({ method: 'tools/call', params: { name, arguments: args } });
const ok = result => {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return result.structuredContent;
};
const invalid = result => {
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.match(result.content[0].text, /Invalid resultLevel/);
};
async function init(projectId) {
  ok(await call('adaptive_initialize_project', { projectId, goal: 'Verify compact results', successCriteria: ['verified tests'] }));
  return projectId;
}
async function diskSnapshot() {
  return Object.fromEntries(await Promise.all((await readdir(dir)).sort().map(async name => [name, await readFile(path.join(dir, name), 'utf8')])));
}
const planInput = { action: 'Run the focused contract tests', why: 'Verify the missing success criterion', expectedEvidence: 'Test output',
  risk: 'high', reversible: false, verificationRisk: 'high', expectedDecisionImpact: 'high', strategyKey: 'contract-tests',
  newEvidenceIds: ['new-input'], changedConditions: 'contract@2' };
const cacheRecord = { evidenceId: 'evidence-1', kind: 'test', target: 'contract', params: { suite: 'focused' },
  dependencies: ['contract@2'], dependencyIds: ['contract'], freshness: 'fresh', result: { output: 'Complete verified test log', passed: 7 } };
const cacheRequest = { kind: cacheRecord.kind, target: cacheRecord.target, params: cacheRecord.params, dependencies: cacheRecord.dependencies };
const observationInput = { operation: 'observation', observation: 'The complete test output supports the contract', evidence: 'test-log:7', confidence: 0.9, evidenceRecord: cacheRecord };

// Exact summary omissions. Null values and all unlisted fields must survive.
// Route guidance/reasons are intentionally retained, including off/stop/justify.
const routeOmissions = ['score', 'complexity', 'uncertainty', 'expectedIterations', 'contextDetail', 'cycleBudget'];
const planOmissions = ['action', 'why', 'expectedEvidence', 'createdAt'];
const observationOmissions = ['observation', 'evidence', 'createdAt'];
const claimOmissions = ['createdAt', 'updatedAt'];
const transferOmissions = ['createdAt', 'updatedAt', 'relevance'];
function assertProjection(actual, raw, omissions, level) {
  const expected = { ...raw };
  if (level === 'summary') for (const field of omissions) if (expected[field] !== null) delete expected[field];
  assert.deepEqual(actual, expected);
}
const options = level => level === undefined ? {} : { resultLevel: level };

test('scratch state directory is outside the plugin source root', async () => {
  const root = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const relative = path.relative(root, await realpath(dir));
  assert.ok(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative),
    `Scratch state directory must be outside the plugin source root: ${dir}`);
});

test('discovery preserves exactly 19 names and exposes optional summary/full only on selected controls', async () => {
  const { tools } = await dispatch({ method: 'tools/list' });
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'forge_route', 'forge_goal', 'forge_context', 'forge_observe', 'forge_plan', 'forge_evaluate', 'forge_adapt', 'forge_checkpoint', 'forge_consolidate',
    'adaptive_route_task', 'adaptive_get_context', 'adaptive_initialize_project', 'adaptive_get_state', 'adaptive_list_projects',
    'adaptive_record_observation', 'adaptive_record_hypothesis', 'adaptive_record_experiment', 'adaptive_checkpoint', 'adaptive_consolidate',
  ].sort());
  for (const tool of tools) {
    if (selected.includes(tool.name)) {
      assert.deepEqual(tool.inputSchema.properties.resultLevel?.enum, ['summary', 'full'], tool.name);
      assert.equal(tool.inputSchema.properties.resultLevel.type, 'string');
      assert.ok(!tool.inputSchema.required.includes('resultLevel'));
    } else if (tool.name !== 'forge_context') assert.equal(tool.inputSchema.properties.resultLevel, undefined);
  }
});

for (const level of [undefined, 'full', 'summary']) {
  test(`${level ?? 'default'} preserves observe wrappers and epistemic data for all operations`, async () => {
    const projectId = await init(`observe-${level}`);
    const observe = args => call('forge_observe', { projectId, ...args, ...options(level) });
    const result = await observe(observationInput);
    const observed = ok(result);
    let state = await store.getProject(projectId);
    assert.deepEqual(result.content, [{ type: 'text', text: 'Forge observation recorded.' }]);
    assert.deepEqual(Object.keys(observed).sort(), ['evidenceRecord', 'observation']);
    assertProjection(observed.observation, state.observations[0], observationOmissions, level);
    assertProjection(observed.evidenceRecord, state.efficiency.evidenceCache[0], ['result'], level);
    assert.equal(state.observations[0].observation, observationInput.observation);
    assert.equal(state.observations[0].evidence, observationInput.evidence);
    assert.deepEqual(state.efficiency.evidenceCache[0].result, cacheRecord.result);
    const bare = ok(await observe({ operation: 'observation', observation: 'No attached record' }));
    assert.deepEqual(Object.keys(bare), ['observation']);
    assert.equal(bare.observation.evidence, null);
    const claim = ok(await observe({ operation: 'claim', statement: 'Evidence supports this scoped claim', claimStatus: 'known', confidence: 0.8,
      evidenceIds: ['evidence-1'], counterEvidenceIds: ['counter-1'], scope: 'task', scopeId: 'task-1' })).claim;
    state = await store.getProject(projectId);
    assertProjection(claim, state.claims[0], claimOmissions, level);
    const updated = ok(await observe({ operation: 'update_claim', claimId: claim.id, claimStatus: 'contradicted', counterEvidenceIds: ['counter-2'] })).claim;
    state = await store.getProject(projectId);
    assertProjection(updated, state.claims[0], claimOmissions, level);
    assert.equal(updated.status, 'contradicted');
    const candidate = ok(await observe({ operation: 'transfer_candidate', sourceProjectId: 'other-project', lesson: 'Validate every transferred claim locally', relevance: 'Shared contract' })).transferCandidate;
    state = await store.getProject(projectId);
    assertProjection(candidate, state.transferCandidates[0], transferOmissions, level);
    assert.equal(candidate.status, 'candidate');
    const validated = ok(await observe({ operation: 'validate_transfer', candidateId: candidate.id, evidenceIds: ['local-validation'] })).transferCandidate;
    state = await store.getProject(projectId);
    assertProjection(validated, state.transferCandidates[0], transferOmissions, level);
    assert.equal(validated.status, 'validated');
    assert.deepEqual(validated.validationEvidenceIds, ['local-validation']);
  });

  test(`${level ?? 'default'} preserves plan safety, retry fields, evaluations and complete persisted records`, async () => {
    const projectId = await init(`plan-${level}`);
    const result = await call('forge_plan', { projectId, ...planInput, ...options(level) });
    const { plan } = ok(result);
    let state = await store.getProject(projectId);
    assert.deepEqual(result.content, [{ type: 'text', text: 'Forge next-action plan recorded.' }]);
    assert.deepEqual(Object.keys(result.structuredContent), ['plan']);
    assertProjection(plan, state.plans[0], planOmissions, level);
    assert.equal(plan.verificationStrength, 'strong');
    assert.equal(state.plans[0].action, planInput.action);
    assert.equal(state.plans[0].why, planInput.why);
    assert.equal(state.plans[0].expectedEvidence, planInput.expectedEvidence);
    for (const outcome of ['verified', 'partially_verified', 'inconclusive', 'falsified', 'blocked']) {
      const response = await call('forge_evaluate', { projectId, planId: plan.id, outcome, summary: `Result is ${outcome}`,
        evidenceIds: ['evaluation-log'], missingCriteria: ['Pending independent check'], ...options(level) });
      const { evaluation } = ok(response);
      state = await store.getProject(projectId);
      assert.deepEqual(response.content, [{ type: 'text', text: `Forge evaluation recorded: ${outcome}.` }]);
      assertProjection(evaluation, state.evaluations.at(-1), ['createdAt'], level);
      assert.equal(evaluation.summary, `Result is ${outcome}`);
      assert.deepEqual(evaluation.missingCriteria, ['Pending independent check']);
    }
  });
}

test('invalid level types, null and unknown values reject every selected path before any disk write', async () => {
  const projectId = await init('invalid-level');
  const claim = ok(await call('forge_observe', { projectId, operation: 'claim', statement: 'Claim' })).claim;
  const candidate = ok(await call('forge_observe', { projectId, operation: 'transfer_candidate', sourceProjectId: 'source', lesson: 'Lesson' })).transferCandidate;
  ok(await call('forge_observe', { projectId, ...observationInput }));
  const before = await diskSnapshot();
  const operations = [
    ['forge_route', { projectId, complexity: 'complex', cacheRequest }],
    ['forge_route', { complexity: 'simple' }],
    ['forge_plan', { projectId, ...planInput, cacheRequest }],
    ['forge_evaluate', { projectId, outcome: 'blocked', summary: 'Blocked' }],
    ['forge_observe', { projectId, ...observationInput }],
    ['forge_observe', { projectId, operation: 'claim', statement: 'Another claim' }],
    ['forge_observe', { projectId, operation: 'update_claim', claimId: claim.id, statement: 'Changed' }],
    ['forge_observe', { projectId, operation: 'transfer_candidate', sourceProjectId: 'source', lesson: 'Another lesson' }],
    ['forge_observe', { projectId, operation: 'validate_transfer', candidateId: candidate.id, evidenceIds: ['local'] }],
  ];
  for (const [name, args] of operations) for (const resultLevel of [null, true, 1, {}, [], 'relevant', '', 'FULL']) {
    invalid(await call(name, { ...args, resultLevel }));
    assert.deepEqual(await diskSnapshot(), before, `${name}/${args.operation ?? 'route or plan'}`);
  }
});

test('valid levels preserve missing project, validation and unknown-operation error envelopes', async () => {
  const projectId = await init('errors');
  for (const [name, args] of [
    ['forge_route', { projectId: 'absent', complexity: 'complex' }],
    ['forge_plan', { projectId: 'absent', ...planInput }],
    ['forge_evaluate', { projectId: 'absent', outcome: 'blocked', summary: 'Blocked' }],
    ['forge_observe', { projectId: 'absent', ...observationInput }],
    ['forge_observe', { projectId, operation: 'unknown' }],
    ['forge_observe', { projectId, operation: 'claim', statement: 'Unproven', claimStatus: 'known' }],
    ['forge_observe', { projectId, operation: 'validate_transfer', candidateId: 'absent' }],
    ['forge_route', { complexity: 'complex', cacheRequest }],
    ['forge_plan', { projectId, action: '', why: 'Invalid action' }],
    ['forge_evaluate', { projectId, outcome: 'invalid', summary: 'Invalid outcome' }],
  ]) {
    const original = await call(name, args);
    assert.equal(original.isError, true);
    assert.deepEqual(await call(name, { ...args, resultLevel: 'full' }), original);
    assert.deepEqual(await call(name, { ...args, resultLevel: 'summary' }), original);
  }
});

test('stateless summary matches full routing including off, utility, completion, justification and risk guidance', async () => {
  for (const args of [
    { complexity: 'simple' },
    { complexity: 'complex', uncertainty: 'high', risk: 'high', unresolvedCycles: 1 },
    { complexity: 'complex', completedCycles: 3 },
    { complexity: 'complex', completedCycles: 3, candidateWouldVerifySuccessCriterion: true },
    { complexity: 'complex', duplicateValidEvidence: true },
    { complexity: 'complex', successCriteriaSatisfied: true, evidenceSufficient: true, contradictionRemaining: false, meaningfulRiskRemaining: false },
  ]) {
    const original = await call('forge_route', args);
    assert.deepEqual(await call('forge_route', { ...args, resultLevel: 'full' }), original);
    const summary = await call('forge_route', { ...args, resultLevel: 'summary' });
    assert.deepEqual(summary.content, original.content);
    assert.deepEqual(Object.keys(ok(summary)), Object.keys(ok(original)));
    assertProjection(ok(summary).route, ok(original).route, routeOmissions, 'summary');
    assert.equal(ok(summary).noticeRequired, false);
    assert.equal(ok(summary).deepNoticeRequired, false);
    assert.ok(Buffer.byteLength(JSON.stringify(summary)) < Buffer.byteLength(JSON.stringify(original)));
  }
});

test('project summaries retain notices and routing decisions and archive the full route', async () => {
  const projectId = await init('project-routing');
  const args = { projectId, complexity: 'complex', uncertainty: 'high', risk: 'high', completedCycles: 3,
    candidateWouldVerifySuccessCriterion: true, resultLevel: 'summary' };
  const before = await store.getProject(projectId);
  const expected = routeWithEfficiency(args, before.efficiency);
  const summary = ok(await call('forge_route', args));
  assertProjection(summary.route, expected, routeOmissions, 'summary');
  assert.equal(summary.noticeRequired, true);
  assert.equal(summary.deepNoticeRequired, true);
  assert.equal(summary.route.requiresJustification, true);
  assert.equal(summary.route.efficiencyDecision, 'allow');
  const state = await store.getProject(projectId);
  assert.deepEqual(state.efficiency.lastRoute, { ...expected, completedCycles: 3 });
  assert.deepEqual(state.efficiency.ledger, before.efficiency.ledger);
  ok(await call('forge_adapt', { projectId, operation: 'acknowledge_usage', firstUseNoticeAcknowledged: true, deepWarningAcknowledged: true }));
  const acknowledged = ok(await call('forge_route', args));
  assert.equal(acknowledged.noticeRequired, false);
  assert.equal(acknowledged.deepNoticeRequired, false);
});

test('summary registration omits acknowledged cache result but route and plan retrieval retain the full record', async () => {
  const projectId = await init('cache-results');
  const registered = ok(await call('forge_observe', { projectId, ...observationInput, resultLevel: 'summary' }));
  assert.equal(Object.hasOwn(registered.evidenceRecord, 'result'), false);
  const raw = (await store.getProject(projectId)).efficiency.evidenceCache[0];
  for (const [name, args] of [['forge_route', { complexity: 'complex' }], ['forge_plan', planInput]]) {
    const result = ok(await call(name, { projectId, ...args, cacheRequest, resultLevel: 'summary' }));
    assert.deepEqual(result.evidenceRecord, raw);
    if (name === 'forge_plan') {
      assert.equal(result.plan, null);
      assert.equal(result.efficiencyDecision, 'reuse');
    } else assert.equal(result.route.efficiencyDecision, 'reuse');
  }
  ok(await call('forge_observe', { projectId, ...observationInput, evidenceRecord: { ...cacheRecord, freshness: 'probably_fresh' }, resultLevel: 'summary' }));
  const route = ok(await call('forge_route', { projectId, complexity: 'complex', risk: 'high', cacheRequest, resultLevel: 'summary' }));
  assert.equal(route.evidenceRecord, null);
  const plan = ok(await call('forge_plan', { projectId, ...planInput, cacheRequest, resultLevel: 'summary' }));
  assert.equal(plan.evidenceRecord, null);
  assert.equal(plan.plan.verificationStrength, 'strong');
  assert.equal((await store.getProject(projectId)).efficiency.ledger.reusedEvidence, 2);
});

test('summary cannot bypass budget justification or failed strategy guards and retains concrete override provenance', async () => {
  const projectId = await init('guards');
  ok(await call('forge_route', { projectId, complexity: 'complex', completedCycles: 3 }));
  const args = { projectId, ...planInput, usageImpact: 'HIGH' };
  const before = await diskSnapshot();
  const original = await call('forge_plan', args);
  assert.equal(original.isError, true);
  assert.match(original.content[0].text, /concrete justification/);
  assert.deepEqual(await call('forge_plan', { ...args, resultLevel: 'summary' }), original);
  assert.deepEqual(await diskSnapshot(), before);
  const budgetOverride = { category: 'unmet_success_criterion', justification: 'The updated response contract still needs verified test results.' };
  const plan = ok(await call('forge_plan', { ...args, budgetOverride, resultLevel: 'summary' })).plan;
  const persisted = (await store.getProject(projectId)).plans[0];
  assertProjection(plan, persisted, planOmissions, 'summary');
  assert.equal(plan.budgetOverride.justification, budgetOverride.justification);
  assert.equal(plan.budgetOverride.provenance.source, 'reported');
  assert.equal(plan.budgetOverride.completedCycles, 3);
  ok(await call('forge_evaluate', { projectId, planId: plan.id, outcome: 'falsified', summary: 'Contract test failed', evidenceIds: ['new-input'], missingCriteria: ['tests pass'], resultLevel: 'summary' }));
  const failedState = await diskSnapshot();
  const retry = await call('forge_plan', { ...args, budgetOverride });
  assert.equal(retry.isError, true);
  assert.match(retry.content[0].text, /Failed strategy/);
  assert.deepEqual(await call('forge_plan', { ...args, budgetOverride, resultLevel: 'summary' }), retry);
  assert.deepEqual(await diskSnapshot(), failedState);
  const changed = ok(await call('forge_plan', { ...args, budgetOverride, newEvidenceIds: ['fresh-log'], changedConditions: 'contract@3', resultLevel: 'summary' })).plan;
  assert.deepEqual(changed.newEvidenceIds, ['fresh-log']);
  assert.equal(changed.changedConditions, 'contract@3');
});

test('stdio restart recovers complete raw inputs and history through context and legacy state', async () => {
  const projectId = 'compact-restart';
  const rpc = operations => {
    const messages = operations.map(([name, args], id) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { projectId, ...args } } }));
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('../server/mcp-server.mjs', import.meta.url)), '--stdio'], {
      env: { ...process.env, ASTRA_PROJECT_FORGE_DATA_DIR: dir }, encoding: 'utf8', timeout: 15000,
      input: messages.map(message => JSON.stringify(message)).join('\n') + '\n',
    });
    assert.equal(child.status, 0, String(child.error ?? child.stderr));
    assert.equal(child.stderr, '');
    return child.stdout.trim().split('\n').map(line => ok(JSON.parse(line).result));
  };
  rpc([
    ['adaptive_initialize_project', { goal: 'Recover compact calls' }],
    ['forge_observe', { ...observationInput, resultLevel: 'summary' }],
    ['forge_plan', { ...planInput, resultLevel: 'summary' }],
    ['forge_evaluate', { outcome: 'blocked', summary: 'External verification pending', missingCriteria: ['external check'], resultLevel: 'summary' }],
    ['forge_route', { complexity: 'complex', resultLevel: 'summary' }],
  ]);
  const raw = await new ProjectStore(dir).getProject(projectId);
  const [full, legacy, recovery] = rpc([
    ['forge_context', { detail: 'full' }], ['adaptive_get_state', {}], ['forge_context', { detail: 'recovery', resultLevel: 'full' }],
  ]);
  assert.deepEqual(full.context.project, raw);
  assert.deepEqual(legacy.project, raw);
  assert.deepEqual(recovery.context.project, raw);
  assert.equal(raw.observations[0].observation, observationInput.observation);
  assert.equal(raw.observations[0].evidence, observationInput.evidence);
  assert.deepEqual(raw.efficiency.evidenceCache[0].result, cacheRecord.result);
  assert.equal(raw.plans[0].action, planInput.action);
  assert.equal(raw.plans[0].why, planInput.why);
  assert.equal(raw.plans[0].expectedEvidence, planInput.expectedEvidence);
  assert.equal(raw.evaluations[0].summary, 'External verification pending');
  assert.ok(raw.evaluations[0].createdAt);
  assert.ok(raw.efficiency.lastRoute.guidance);
  assert.equal(raw.efficiency.lastRoute.complexity, 'complex');
});

test('pure projection is non-mutating, preserves unknown safety additions, nulls and errors', async () => {
  const { projectControlResult } = await import('../server/control-results.mjs');
  const freeze = value => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  };
  for (const [name, key, record, omissions] of [
    ['forge_route', 'route', { score: 9, complexity: 'complex', profile: 'off', guidance: 'Keep off', reasons: ['Safety reason'], stateDetail: 'none', softCycleBudget: 0 }, routeOmissions],
    ['forge_plan', 'plan', { action: 'Echoed action', why: 'Echoed rationale', expectedEvidence: null, createdAt: 'time', risk: 'high', reversible: false, budgetOverride: { justification: 'Needed check', provenance: { source: 'reported' } } }, planOmissions],
    ['forge_observe', 'observation', { observation: 'Echoed text', evidence: null, createdAt: 'time', confidence: 0.9 }, observationOmissions],
    ['forge_observe', 'claim', { statement: 'Claim', status: 'contradicted', counterEvidenceIds: ['counter'], createdAt: 'time', updatedAt: 'time' }, claimOmissions],
    ['forge_observe', 'transferCandidate', { lesson: 'Lesson', status: 'candidate', relevance: 'Echo', createdAt: 'time', updatedAt: 'time' }, transferOmissions],
    ['forge_evaluate', 'evaluation', { summary: 'Blocked', missingCriteria: ['check'], createdAt: 'time' }, ['createdAt']],
  ]) {
    const raw = freeze({ content: [{ type: 'text', text: 'Original message' }], structuredContent: {
      [key]: { ...record, id: 'record-1', revision: 4, futureSafety: { required: true } }, unknownWrapper: { required: true }, nullable: null,
    }, futureEnvelopeSafety: true });
    const snapshot = structuredClone(raw);
    const summary = projectControlResult(name, raw, 'summary');
    assert.deepEqual(raw, snapshot);
    assertProjection(summary.structuredContent[key], raw.structuredContent[key], omissions, 'summary');
    assert.deepEqual(summary.structuredContent.unknownWrapper, { required: true });
    assert.equal(summary.structuredContent.nullable, null);
    assert.equal(summary.futureEnvelopeSafety, true);
    assert.deepEqual(summary.content, raw.content);
    assert.strictEqual(projectControlResult(name, raw), raw);
    assert.strictEqual(projectControlResult(name, raw, 'full'), raw);
    assert.ok(Buffer.byteLength(JSON.stringify(summary)) < Buffer.byteLength(JSON.stringify(raw)));
  }
  const error = freeze({ isError: true, content: [{ type: 'text', text: 'Failure' }] });
  for (const name of selected) assert.strictEqual(projectControlResult(name, error, 'summary'), error);
  const unrelated = freeze({ content: [], structuredContent: { plan: { action: 'Untouched' } } });
  assert.strictEqual(projectControlResult('adaptive_record_experiment', unrelated, 'summary'), unrelated);
});
