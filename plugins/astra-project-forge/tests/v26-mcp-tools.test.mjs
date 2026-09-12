import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.ASTRA_PROJECT_FORGE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'astra-v26-mcp-'));
const { tools, dispatch } = await import('../server/mcp-server.mjs');

test.after(async () => {
  await rm(process.env.ASTRA_PROJECT_FORGE_DATA_DIR, { recursive: true, force: true });
});

test('v2.6 exposes all forge tools while retaining legacy adaptive tools', () => {
  const names = tools.map(tool => tool.name);
  const forgeNames = ['forge_route','forge_goal','forge_context','forge_observe','forge_plan','forge_evaluate','forge_adapt','forge_checkpoint','forge_consolidate'];
  for (const name of forgeNames) assert.ok(names.includes(name), `missing ${name}`);
  assert.ok(names.includes('adaptive_initialize_project'));
  assert.ok(names.includes('adaptive_get_context'));
  assert.ok(names.includes('adaptive_consolidate'));
});

test('forge tools support a routed goal-to-evaluation workflow', async () => {
  const projectId = 'forge-v26-flow';
  await dispatch({ method: 'tools/call', params: { name: 'adaptive_initialize_project', arguments: { projectId, goal: 'Ship v2.6', successCriteria: ['tests pass'] } } });

  const route = await dispatch({ method: 'tools/call', params: { name: 'forge_route', arguments: { complexity: 'complex', uncertainty: 'high', continuityNeeded: true, repeatedFailure: false, crossDomain: true } } });
  assert.equal(route.structuredContent.route.profile, 'deep');
  assert.ok(route.structuredContent.route.usageImpact);

  const createdGoal = await dispatch({ method: 'tools/call', params: { name: 'forge_goal', arguments: { projectId, operation: 'create', parentId: 'goal-root', title: 'Run verification' } } });
  const goalId = createdGoal.structuredContent.goal.id;

  const observed = await dispatch({ method: 'tools/call', params: { name: 'forge_observe', arguments: { projectId, operation: 'observation', observation: 'Unit tests pass', evidence: 'npm test', confidence: 0.99 } } });
  assert.match(observed.structuredContent.observation.id, /^obs-/);

  const planned = await dispatch({ method: 'tools/call', params: { name: 'forge_plan', arguments: { projectId, goalId, action: 'Run package verification', why: 'Confirm release artifact', risk: 'low', reversible: true, usageImpact: 'LOW' } } });
  const planId = planned.structuredContent.plan.id;

  const evaluated = await dispatch({ method: 'tools/call', params: { name: 'forge_evaluate', arguments: { projectId, goalId, planId, outcome: 'verified', summary: 'Package verified', evidenceIds: ['package-check'] } } });
  assert.equal(evaluated.structuredContent.evaluation.outcome, 'verified');

  const context = await dispatch({ method: 'tools/call', params: { name: 'forge_context', arguments: { projectId, detail: 'working', maxItems: 5 } } });
  assert.equal(context.structuredContent.context.project.projectId, projectId);
  assert.ok(context.structuredContent.context.counts);
});
