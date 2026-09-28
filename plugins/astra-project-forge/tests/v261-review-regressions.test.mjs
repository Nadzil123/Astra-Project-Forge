import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProjectStore } from '../server/state-store.mjs';

const dir = await mkdtemp(path.join(tmpdir(), 'forge-final-review-'));
const previousDataDir = process.env.ASTRA_PROJECT_FORGE_DATA_DIR;
process.env.ASTRA_PROJECT_FORGE_DATA_DIR = dir;
const { processRpcMessage } = await import('../server/mcp-server.mjs');
test.after(async () => {
  if (previousDataDir === undefined) delete process.env.ASTRA_PROJECT_FORGE_DATA_DIR;
  else process.env.ASTRA_PROJECT_FORGE_DATA_DIR = previousDataDir;
  await rm(dir, { recursive: true, force: true });
});
const store = new ProjectStore(dir);
let sequence = 0;
const identity = { kind: 'test', target: 'contract', params: null, dependencies: ['source@a'] };
const evidence = patch => ({
  ...identity, evidenceId: 'first-run', dependencyIds: ['source'], freshness: 'fresh', ...patch,
});
const firstResult = { passed: true, log: 'log:first' };
const ok = response => {
  assert.equal(response.error, undefined, JSON.stringify(response));
  assert.notEqual(response.result.isError, true, JSON.stringify(response));
  return response.result.structuredContent;
};
const rpc = async (name, args) => ok(await processRpcMessage({
  jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: { name, arguments: args },
}));
async function init() {
  const projectId = `review-${++sequence}`;
  await rpc('adaptive_initialize_project', { projectId, goal: 'Verify independent evidence' });
  return projectId;
}
const observe = (projectId, patch = {}) => store.recordObservation(projectId, {
  observation: 'First sample passed', evidence: 'log:first',
  evidenceRecord: evidence({ result: firstResult, vendor: { retained: true }, ...patch }),
});
function restart(projectId, operations) {
  const messages = operations.map(([name, args], id) => ({
    jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { projectId, ...args } },
  }));
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('../server/mcp-server.mjs', import.meta.url)), '--stdio'], {
    env: { ...process.env, ASTRA_PROJECT_FORGE_DATA_DIR: dir }, cwd: tmpdir(), encoding: 'utf8',
    input: messages.map(message => JSON.stringify(message)).join('\n') + '\n',
  });
  assert.equal(child.status, 0, String(child.error ?? child.stderr));
  assert.equal(child.stderr, '');
  const responses = child.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(responses.map(response => response.id), messages.map(message => message.id));
  return responses.map(ok);
}

for (const field of ['result', 'observationId']) {
  test(`direct replacement drops omitted ${field} after invalidation and restart`, async () => {
    const projectId = await init();
    const first = await observe(projectId);
    await store.invalidateEvidence(projectId, ['source']);
    assert.equal(await store.findReusableEvidence(projectId, identity), null);
    const replaced = await store.upsertEvidenceRecord(projectId, evidence({ evidenceId: 'second-run' }));
    const restarted = new ProjectStore(dir);
    const retrieved = await restarted.findReusableEvidence(projectId, identity);
    const full = await restarted.getContext(projectId, { detail: 'full', resultLevel: 'full' });
    for (const record of [replaced, retrieved, full.project.efficiency.evidenceCache[0]]) {
      assert.equal(Object.hasOwn(record, field), false, `${field} belongs to the former evidence`);
      assert.equal(record.evidenceId, 'second-run');
      assert.equal(record.freshness, 'fresh');
      assert.deepEqual(record.vendor, { retained: true });
      assert.ok(record.revision > first.evidenceRecord.revision);
    }
    assert.equal(full.project.observations[0].id, first.observation.id);
  });
}

test('direct upsert cannot forge observation ownership on insertion or replacement', async () => {
  const projectId = await init();
  for (const evidenceId of ['direct-first', 'direct-second']) {
    const record = await store.upsertEvidenceRecord(projectId, evidence({ evidenceId, observationId: 'caller-supplied' }));
    assert.equal(Object.hasOwn(record, 'observationId'), false);
  }
  assert.deepEqual((await store.getProject(projectId)).observations, []);
});

test('same-ID direct metadata updates retain result and actual observation ownership', async () => {
  const projectId = await init();
  const first = await observe(projectId);
  const updated = await store.upsertEvidenceRecord(projectId, evidence({
    observationId: 'caller-supplied', annotation: 'reviewed', vendor: { retained: true, reviewed: true },
  }));
  assert.equal(updated.observationId, first.observation.id);
  assert.deepEqual(updated.result, firstResult);
  assert.deepEqual(updated.vendor, { retained: true, reviewed: true });
  assert.equal(updated.annotation, 'reviewed');
  assert.deepEqual(await new ProjectStore(dir).findReusableEvidence(projectId, identity), updated);
});

for (const result of [{ passed: false, log: 'log:second' }, null]) {
  test(`direct replacement preserves explicitly supplied result ${JSON.stringify(result)}`, async () => {
    const projectId = await init();
    await observe(projectId);
    await store.invalidateEvidence(projectId, ['source']);
    const updated = await store.upsertEvidenceRecord(projectId, evidence({ evidenceId: 'second-run', result }));
    const retrieved = await new ProjectStore(dir).reuseEvidence(projectId, identity);
    for (const record of [updated, retrieved]) {
      assert.equal(Object.hasOwn(record, 'result'), true);
      assert.deepEqual(record.result, result);
      assert.equal(Object.hasOwn(record, 'observationId'), false);
      assert.deepEqual(record.vendor, { retained: true });
    }
  });
}

for (const resultLevel of ['full', 'summary']) {
  for (const [label, payload] of [
    ['omitted', {}], ['new result', { result: { passed: false, log: 'log:second' } }], ['null', { result: null }],
  ]) {
    test(`MCP ${resultLevel} replacement with ${label} keeps only current payload attribution`, async () => {
      const projectId = await init();
      const first = await rpc('forge_observe', { projectId, operation: 'observation', resultLevel,
        observation: 'First sample passed', evidence: 'log:first',
        evidenceRecord: evidence({ result: firstResult, vendor: { retained: true } }),
      });
      await rpc('forge_adapt', { projectId, operation: 'invalidate_evidence', changedDependencyIds: ['source'] });
      const second = await rpc('forge_observe', { projectId, operation: 'observation', resultLevel,
        observation: 'Rerun failed; prose is not a result payload', evidence: 'log:second',
        evidenceRecord: evidence({ evidenceId: 'second-run', observationId: first.observation.id, ...payload }),
      });
      assert.notEqual(second.observation.id, first.observation.id);
      assert.equal(second.evidenceRecord.observationId, second.observation.id);
      if (resultLevel === 'full' || label !== 'new result') {
        assert.equal(Object.hasOwn(second.evidenceRecord, 'result'), Object.hasOwn(payload, 'result'));
        assert.deepEqual(second.evidenceRecord.result, payload.result);
      }
      const routed = await rpc('forge_route', { projectId, complexity: 'complex', cacheRequest: identity, resultLevel });
      assert.equal(routed.route.efficiencyDecision, 'reuse');
      const records = [routed.evidenceRecord, await new ProjectStore(dir).findReusableEvidence(projectId, identity)];
      if (label === 'omitted') {
        const [retrieved, full, recovered, raw] = restart(projectId, [
          ['forge_route', { complexity: 'complex', cacheRequest: identity, resultLevel }],
          ['forge_context', { detail: 'full', resultLevel: 'full' }],
          ['forge_context', { detail: 'recovery', resultLevel: 'full' }],
          ['adaptive_get_state', {}],
        ]);
        records.push(retrieved.evidenceRecord);
        for (const project of [full.context.project, recovered.context.project, raw.project]) {
          assert.deepEqual(project.observations.map(record => record.id), [first.observation.id, second.observation.id]);
          records.push(...project.efficiency.evidenceCache);
        }
      }
      for (const record of records) {
        assert.equal(record.evidenceId, 'second-run');
        assert.equal(record.observationId, second.observation.id);
        assert.equal(Object.hasOwn(record, 'result'), Object.hasOwn(payload, 'result'));
        assert.deepEqual(record.result, payload.result);
        assert.deepEqual(record.vendor, { retained: true });
      }
    });
  }
}

test('same-ID observation metadata updates keep payload and use the registering observation', async () => {
  const projectId = await init();
  const first = await observe(projectId);
  const updated = await store.recordObservation(projectId, {
    observation: 'Reviewed the same evidence', evidenceRecord: evidence({ observationId: first.observation.id, annotation: 'reviewed' }),
  });
  assert.notEqual(updated.observation.id, first.observation.id);
  assert.equal(updated.evidenceRecord.observationId, updated.observation.id);
  assert.deepEqual(updated.evidenceRecord.result, firstResult);
  assert.deepEqual(updated.evidenceRecord.vendor, { retained: true });
});

const candidate = {
  complexity: 'complex', currentLevel: 'low', completedCycles: 4,
  successCriteriaSatisfied: false, evidenceSufficient: false,
  duplicateValidEvidence: true, candidateHasIndependentValue: true,
};
const independentCases = [
  ['failure detection', { candidateWouldDetectFailure: true }, ['meaningful_failure_detection']],
  ['evidence-driven replan', { newEvidenceRequiresReplan: true, candidateWouldReplan: true }, ['new_evidence_requires_replan']],
];

for (const [label, signals, usefulReasons] of independentCases) {
  test(`direct route preserves independent ${label} at the soft budget despite matching cache`, async () => {
    const projectId = await init();
    await observe(projectId);
    const withoutCache = await store.routeProject(projectId, { ...candidate, ...signals });
    const withCache = await store.routeProject(projectId, { ...candidate, ...signals, cacheRequest: identity });
    assert.equal(withoutCache.route.efficiencyDecision, 'allow');
    assert.equal(withoutCache.route.requiresJustification, true);
    assert.deepEqual(withCache.route, withoutCache.route);
    assert.deepEqual(withCache.route.usefulReasons, usefulReasons);
    assert.equal(withCache.evidenceRecord, null);
    const state = await new ProjectStore(dir).getProject(projectId);
    assert.equal(state.efficiency.lastRoute.efficiencyDecision, 'allow');
    assert.equal(state.efficiency.lastRoute.requiresJustification, true);
    assert.equal(state.efficiency.ledger.reusedEvidence, 0);
    assert.deepEqual(state.efficiency.ledger.events, []);
    assert.deepEqual((await store.findReusableEvidence(projectId, identity)).result, firstResult);
  });
}

for (const resultLevel of ['full', 'summary']) {
  test(`MCP ${resultLevel} preserves independent utility and justification without recording reuse`, async () => {
    const projectId = await init();
    await observe(projectId);
    const args = { projectId, ...candidate, candidateWouldDetectFailure: true };
    const withoutCache = await rpc('forge_route', { ...args, resultLevel });
    const full = await rpc('forge_route', { ...args, resultLevel: 'full', cacheRequest: identity });
    const withCache = await rpc('forge_route', { ...args, resultLevel, cacheRequest: identity });
    assert.equal(withoutCache.route.efficiencyDecision, 'allow');
    assert.equal(withoutCache.route.requiresJustification, true);
    assert.deepEqual(withCache.route, withoutCache.route);
    assert.deepEqual(withCache.route.usefulReasons, ['meaningful_failure_detection']);
    assert.equal(withCache.evidenceRecord, null);
    assert.equal(full.evidenceRecord, null);
    for (const field of ['efficiencyDecision', 'requiresJustification', 'usefulReasons', 'wasteReasons', 'completionRecommended']) {
      assert.deepEqual(withCache.route[field], full.route[field]);
    }
    const { project } = await rpc('adaptive_get_state', { projectId });
    assert.equal(project.efficiency.ledger.reusedEvidence, 0);
    assert.equal(project.efficiency.ledger.duplicateToolCallsAvoided, 0);
    assert.deepEqual(project.efficiency.ledger.events, []);

    const planArgs = { projectId, action: 'Take an independent sample', why: 'Detect intermittent failures', usageImpact: 'HIGH', resultLevel };
    const rejected = await processRpcMessage({ jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: { name: 'forge_plan', arguments: planArgs } });
    assert.equal(rejected.result.isError, true);
    assert.match(rejected.result.content[0].text, /budgetOverride/);
    const { plan } = await rpc('forge_plan', { ...planArgs, budgetOverride: {
      category: 'unmet_success_criterion', justification: 'An independent sample is still required to detect intermittent failures.',
    } });
    assert.equal(plan.budgetOverride.category, 'unmet_success_criterion');
    assert.equal(plan.budgetOverride.provenance.source, 'reported');
  });

  test(`MCP ${resultLevel} keeps ordinary reuse and completion precedence`, async () => {
    const projectId = await init();
    await observe(projectId);
    for (const signals of [
      { candidateHasIndependentValue: false, candidateWouldDetectFailure: true },
      { candidateHasIndependentValue: true, candidateWouldReplan: true },
    ]) {
      const result = await rpc('forge_route', { projectId, ...candidate, ...signals, cacheRequest: identity, resultLevel });
      assert.equal(result.route.efficiencyDecision, 'reuse');
      assert.equal(result.route.requiresJustification, false);
      assert.deepEqual(result.evidenceRecord.result, firstResult);
    }
    const completed = await rpc('forge_route', { projectId, ...candidate, cacheRequest: identity, resultLevel,
      candidateWouldDetectFailure: true, successCriteriaSatisfied: true, evidenceSufficient: true,
      contradictionRemaining: false, meaningfulRiskRemaining: false,
    });
    assert.equal(completed.route.efficiencyDecision, 'stop');
    assert.equal(completed.route.completionRecommended, true);
    assert.equal(completed.route.requiresJustification, false);
    assert.deepEqual(completed.evidenceRecord.result, firstResult);
    const { project } = await rpc('adaptive_get_state', { projectId });
    assert.equal(project.efficiency.ledger.reusedEvidence, 3);
    assert.equal(project.efficiency.ledger.duplicateToolCallsAvoided, 0);
  });
}
