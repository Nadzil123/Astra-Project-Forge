import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../server/state-store.mjs';

test('working context includes decision-relevant v2.6 goal, claim, plan, evaluation, and transfer state', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'astra-v26-context2-'));
  try {
    const store = new ProjectStore(dir);
    await store.initializeProject({ projectId: 'p', goal: 'Ship v2.6' });
    const goal = await store.addGoal('p', { parentId: 'goal-root', title: 'Verify package' });
    await store.addClaim('p', { statement: 'Package may have stale metadata', status: 'unknown' });
    const plan = await store.addPlan('p', { goalId: goal.id, action: 'Inspect manifest', why: 'Check metadata', usageImpact: 'LOW' });
    await store.addEvaluation('p', { goalId: goal.id, planId: plan.id, outcome: 'inconclusive', summary: 'Need fresh package test' });
    await store.addTransferCandidate('p', { sourceProjectId: 'old', lesson: 'Re-extract ZIP before final verification' });

    const context = await store.getContext('p', { detail: 'working', maxItems: 5 });
    assert.ok(context.goals.some(item => item.id === goal.id));
    assert.ok(context.claims.some(item => item.status === 'unknown'));
    assert.equal(context.plans.at(-1).id, plan.id);
    assert.equal(context.evaluations.at(-1).outcome, 'inconclusive');
    assert.equal(context.transferCandidates.at(-1).status, 'candidate');
    assert.equal(context.counts.goals, 2);
    assert.equal(context.counts.claims, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
