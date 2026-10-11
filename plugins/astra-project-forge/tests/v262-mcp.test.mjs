import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(tmpdir(), 'forge-v262-mcp-'));
process.env.ASTRA_PROJECT_FORGE_DATA_DIR = dir;
const { dispatch } = await import('../server/mcp-server.mjs');
test.after(() => rm(dir, { recursive: true, force: true }));
const call = (name, args) => dispatch({ method: 'tools/call', params: { name, arguments: args } });
const ok = result => { assert.notEqual(result.isError, true, JSON.stringify(result)); return result.structuredContent; };
async function init(projectId) {
  ok(await call('adaptive_initialize_project', { projectId, goal: 'Safe release', successCriteria: ['passes'], constraints: ['Preserve safety'] }));
  return ok(await call('forge_context', { projectId, detail: 'full' })).context.project;
}
const evidence = { evidenceId: 'test-evidence', kind: 'test', target: 'contract', dependencies: ['contract:v1'], dependencyIds: ['contract'], freshness: 'fresh', result: { passed: true } };
const fused = project => ({ projectId: project.projectId, outcome: 'verified', summary: 'Reported pass', evidenceIds: ['test-evidence'],
  coordination: { operationId: 'evaluate-once', stateEpoch: project.coordination.epoch, expectedRevision: project.revision,
    evidenceRecords: [evidence], criteriaUpdates: [{ goalId: 'goal-root', criterion: 'passes', satisfied: true, evidenceIds: ['test-evidence'] }] } });
async function snapshot() {
  return Object.fromEntries(await Promise.all((await readdir(dir)).filter(name => name.endsWith('.json')).map(async name => [name, await readFile(path.join(dir, name), 'utf8')])));
}

test('catalog remains stable and all new MCP inputs are optional', async () => {
  const { tools } = await dispatch({ method: 'tools/list' });
  assert.equal(tools.length, 19);
  for (const name of ['forge_route', 'forge_plan', 'forge_observe', 'forge_evaluate', 'forge_context']) {
    const schema = tools.find(tool => tool.name === name).inputSchema;
    assert.ok(schema.properties.resultLevel.enum.includes('capsule'));
    assert.ok(!schema.required.includes('resultLevel'));
  }
  const evaluate = tools.find(tool => tool.name === 'forge_evaluate').inputSchema;
  assert.ok(evaluate.properties.coordination);
  assert.deepEqual(evaluate.required, ['projectId', 'outcome', 'summary']);
});

test('MCP fused evaluation commits once and every projection preserves historical replay completion', async () => {
  const input = fused(await init('fusion'));
  const result = ok(await call('forge_evaluate', input));
  assert.equal(result.identity.revision, input.coordination.expectedRevision + 1);
  assert.equal(result.completion.recommended, true);
  assert.equal(result.completion.assessmentSource, 'reported');
  ok(await call('forge_observe', { projectId: 'fusion', operation: 'claim', statement: 'Unresolved issue', claimStatus: 'unknown' }));
  const before = await snapshot();
  for (const resultLevel of ['full', 'summary', 'capsule']) {
    const replay = ok(await call('forge_evaluate', { ...input, resultLevel }));
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.identity, result.identity);
    assert.deepEqual(replay.completion, result.completion);
    assert.deepEqual(replay.refs, result.refs);
    if (resultLevel === 'capsule') {
      assert.ok(replay.currentDecisionCapsule.identity.revision > replay.identity.revision);
      assert.equal(replay.currentDecisionCapsule.completion.recommended, false);
    }
  }
  assert.deepEqual(await snapshot(), before);
  const conflict = await call('forge_evaluate', { ...input, coordination: { ...input.coordination, operationId: 'other' } });
  assert.equal(conflict.isError, true); assert.match(conflict.content[0].text, /revision conflict/i);
  const changed = await call('forge_evaluate', { ...input, summary: 'Different payload' });
  assert.equal(changed.isError, true); assert.match(changed.content[0].text, /digest/);
});

test('capsule references expand explicitly and full/recovery remain reachable read-only', async () => {
  await init('expansion');
  const observed = ok(await call('forge_observe', { projectId: 'expansion', operation: 'observation', observation: 'Complete test log', evidenceRecord: evidence, resultLevel: 'capsule' }));
  assert.ok(observed.decisionCapsule.constraints.includes('Preserve safety'));
  const capsule = ok(await call('forge_context', { projectId: 'expansion', resultLevel: 'capsule' })).context;
  const ref = capsule.refs.find(ref => ref.kind === 'observation');
  const before = await snapshot();
  const expansion = ok(await call('forge_context', { projectId: 'expansion', references: [ref] })).context;
  assert.equal(expansion.references[0].status, 'unchanged');
  assert.equal(expansion.references[0].record.observation, 'Complete test log');
  const explicit = ok(await call('forge_context', { projectId: 'expansion', references: [ref], resultLevel: 'full' })).context;
  assert.deepEqual(explicit, expansion);
  const known = ok(await call('forge_context', { projectId: 'expansion', resultLevel: 'capsule', knownRefs: [ref] })).context;
  assert.equal(known.expansion.referenceStatuses[0].status, 'unchanged');
  assert.equal(Object.hasOwn(known.expansion.referenceStatuses[0], 'record'), false);
  for (const detail of ['full', 'recovery']) assert.ok(ok(await call('forge_context', { projectId: 'expansion', detail, resultLevel: 'full' })).context.project);
  const resync = ok(await call('forge_context', { projectId: 'expansion', resultLevel: 'capsule', cursor: { projectId: 'expansion', epoch: 'old', revision: 0 } })).context;
  assert.equal(resync.incomplete, true); assert.match(resync.expansion.resync.reason, /scope mismatch/);
  assert.deepEqual(await snapshot(), before);
});

test('route includeContext returns decision context in one call and keeps projectless guidance complete', async () => {
  await init('route-context');
  const { tools: before } = await dispatch({ method: 'tools/list' });
  const response = ok(await call('forge_route', { projectId: 'route-context', complexity: 'complex', includeContext: true, hostCapabilities: { allowedSubset: true } }));
  assert.equal(response.decisionCapsule.identity.projectId, 'route-context');
  assert.deepEqual(response.decisionCapsule.constraints, ['Preserve safety']);
  assert.equal(response.capabilitySelection.mode, 'allowed_subset');
  const plain = ok(await call('forge_route', { complexity: 'simple' }));
  const projectless = ok(await call('forge_route', { complexity: 'simple', includeContext: true, resultLevel: 'capsule', hostCapabilities: {} }));
  assert.deepEqual(projectless.route, plain.route);
  assert.equal(projectless.decisionCapsule, null);
  assert.match(projectless.contextUnavailable, /projectId/);
  assert.equal(projectless.capabilitySelection.mode, 'stable_catalog');
  assert.deepEqual((await dispatch({ method: 'tools/list' })).tools, before);
});

test('capsule control projection retains unmet criteria and safe plan acknowledgements', async () => {
  await init('controls');
  const planned = ok(await call('forge_plan', { projectId: 'controls', action: 'Test', why: 'Verify', risk: 'high', reversible: false, resultLevel: 'capsule' }));
  assert.equal(planned.plan.risk, 'high'); assert.equal(planned.plan.reversible, false);
  assert.ok(planned.decisionCapsule.risk.length);
  const evaluated = ok(await call('forge_evaluate', { projectId: 'controls', planId: planned.plan.id, outcome: 'blocked', summary: 'Missing check', missingCriteria: ['passes'], resultLevel: 'capsule' }));
  assert.deepEqual(evaluated.evaluation.missingCriteria, ['passes']);
  assert.equal(evaluated.evaluation.summary, 'Missing check');
  assert.equal(evaluated.decisionCapsule.completion.recommended, false);
  assert.ok(evaluated.decisionCapsule.completion.blockers.length);
});

test('contradictory and malformed optional inputs reject before any mutation', async () => {
  const project = await init('invalid'); const before = await snapshot();
  for (const args of [
    { resultLevel: 'capsule', sinceRevision: 0 }, { resultLevel: 'capsule', detail: 'full' },
    { resultLevel: 'capsule', detail: 'recovery' }, { references: [], cursor: {} },
    { references: [], resultLevel: 'capsule' }, { references: [], resultLevel: 'summary' },
    { references: [], resultLevel: 'relevant' }, { references: [], sinceRevision: 0 },
    { references: [], detail: 'full' }, { references: [], maxItems: 1 },
    { references: [], knownRefs: [] }, { references: [], goalId: 'goal-root' },
    { knownRefs: [] }, { goalId: 'goal-root' }, { cursor: {} },
    { resultLevel: 'capsule', knownRefs: null }, { references: null },
  ]) {
    const result = await call('forge_context', { projectId: 'invalid', ...args });
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.ok(result.content[0].text.length > 5);
  }
  for (const args of [{ includeContext: null }, { hostCapabilities: null }, { hostCapabilities: { allowedSubset: 1 } }, { hostCapabilities: { invented: true } }]) {
    assert.equal((await call('forge_route', { projectId: 'invalid', complexity: 'complex', ...args })).isError, true);
  }
  for (const coordination of [null, {}, { ...fused(project).coordination, extra: true }, { ...fused(project).coordination, expectedRevision: -1 }]) {
    assert.equal((await call('forge_evaluate', { ...fused(project), coordination })).isError, true);
  }
  assert.deepEqual(await snapshot(), before);
});

for (const scope of ['coordination', 'criterion']) for (const field of ['constructor', 'toString', '__proto__']) {
  test(`JSON-own ${field} in ${scope} rejects before changing persisted bytes`, async () => {
    const input = fused(await init(`reserved-${scope}-${field}`));
    // A JSON round trip models real MCP input, including an own __proto__ key.
    const extra = JSON.parse(`{"${field}":true}`);
    if (scope === 'coordination') input.coordination = { ...input.coordination, ...extra };
    else input.coordination.criteriaUpdates[0] = { ...input.coordination.criteriaUpdates[0], ...extra };
    const before = await snapshot();
    const result = await call('forge_evaluate', JSON.parse(JSON.stringify(input)));
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.match(result.content[0].text, /unsupported field/);
    assert.ok(result.content[0].text.includes(field));
    assert.deepEqual(await snapshot(), before);
  });
}

// Assert the actual serialized JSON-RPC result, not store-only error properties.
test('JSON-RPC coordination conflicts expose current identity and resync without mutation or legacy error changes', async () => {
  const { processRpcMessage } = await import('../server/mcp-server.mjs');
  const rpc = async args => JSON.parse(JSON.stringify(await processRpcMessage({ jsonrpc: '2.0', id: 123,
    method: 'tools/call', params: { name: 'forge_evaluate', arguments: args } })));
  const input = fused(await init('public-conflicts'));
  const receipt = ok((await rpc(input)).result);
  const cases = [
    ['REVISION_CONFLICT', 'Expected revision conflict', { ...input.coordination, operationId: 'new-stale' }],
    ['STATE_EPOCH_CONFLICT', 'State epoch/generation conflict', { ...input.coordination, stateEpoch: 'old-epoch' }],
  ];
  for (const [code, message, coordination] of cases) {
    const before = await snapshot(); const response = await rpc({ ...input, coordination, resultLevel: 'capsule' });
    assert.equal(response.jsonrpc, '2.0'); assert.equal(response.id, 123);
    assert.equal(response.result.isError, true);
    assert.deepEqual(response.result.content, [{ type: 'text', text: message }]);
    assert.equal(response.result.structuredContent?.code, code);
    assert.deepEqual(response.result.structuredContent.identity, receipt.identity);
    assert.deepEqual(response.result.structuredContent.resync.fullContext, { tool: 'forge_context', arguments: { projectId: input.projectId, detail: 'full' } });
    assert.match(response.result.structuredContent.resync.action, /reassess/i);
    assert.deepEqual(await snapshot(), before);
  }
  const legacy = await rpc({ projectId: 'missing-project', outcome: 'verified', summary: 'Legacy failure' });
  assert.deepEqual(legacy.result, { content: [{ type: 'text', text: 'Project not found: missing-project' }], isError: true });
});
