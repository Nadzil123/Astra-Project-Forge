import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../server/state-store.mjs';

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'astra-v26-plan-'));
  const store = new ProjectStore(dir);
  await store.initializeProject({ projectId: 'p', goal: 'Finish robustly', successCriteria: ['tests pass', 'package verified'] });
  return { dir, store };
}

test('records plan and evaluation separately from observations', async () => {
  const { dir, store } = await setup();
  try {
    const plan = await store.addPlan('p', {
      goalId: 'goal-root', action: 'Run focused tests', why: 'Gather discriminating evidence',
      expectedEvidence: 'Failing test isolates the bug', risk: 'low', reversible: true, usageImpact: 'LOW'
    });
    const evaluation = await store.addEvaluation('p', {
      goalId: 'goal-root', planId: plan.id, outcome: 'partially_verified',
      summary: 'Core tests pass but package verification remains', evidenceIds: ['test-run-1'], missingCriteria: ['package verified']
    });
    const project = await store.getProject('p');
    assert.equal(project.plans.length, 1);
    assert.equal(project.evaluations.length, 1);
    assert.equal(project.observations.length, 0);
    assert.equal(evaluation.outcome, 'partially_verified');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('records failure category and requires a materially changed next strategy without new evidence', async () => {
  const { dir, store } = await setup();
  try {
    await assert.rejects(() => store.addAdaptation('p', {
      failureCategory: 'wrong_hypothesis', failedAction: 'Retry same parser rewrite',
      diagnosis: 'The hypothesis was unsupported', nextStrategy: 'Retry same parser rewrite'
    }), /materially change|new evidence/i);

    const adaptation = await store.addAdaptation('p', {
      failureCategory: 'wrong_hypothesis', failedAction: 'Retry same parser rewrite',
      diagnosis: 'The hypothesis was unsupported', nextStrategy: 'Instrument token lookahead first'
    });
    assert.equal(adaptation.failureCategory, 'wrong_hypothesis');
    assert.match(adaptation.id, /^adapt-/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('rejects plans that target a blocked goal', async () => {
  const { dir, store } = await setup();
  try {
    const dependency = await store.addGoal('p', { parentId: 'goal-root', title: 'Dependency' });
    const blocked = await store.addGoal('p', { parentId: 'goal-root', title: 'Blocked work', dependencies: [dependency.id] });
    await assert.rejects(() => store.addPlan('p', {
      goalId: blocked.id, action: 'Do blocked work', why: 'Should not run', risk: 'low', usageImpact: 'LOW'
    }), /blocked/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
