import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ProjectStore } from '../server/state-store.mjs';

test('persists project state and adaptive evidence across store instances', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'astra-project-forge-store-'));
  try {
    const store = new ProjectStore(dir);
    const created = await store.initializeProject({
      projectId: 'NolQu-L',
      goal: 'Implement a verified parser feature',
      mode: 'deep',
      successCriteria: ['parser tests pass'],
      constraints: ['preserve existing syntax']
    });

    assert.equal(created.projectId, 'NolQu-L');
    assert.equal(created.mode, 'deep');

    const observation = await store.addObservation('NolQu-L', {
      observation: 'Parser fails before semantic analysis',
      evidence: 'test fixture parser_17',
      confidence: 0.95
    });
    assert.match(observation.id, /^obs-/);

    const hypothesis = await store.addHypothesis('NolQu-L', {
      hypothesis: 'Token lookahead consumes one delimiter too early',
      test: 'Add a minimal delimiter fixture',
      confidence: 0.7
    });
    assert.match(hypothesis.id, /^hyp-/);

    const experiment = await store.addExperiment('NolQu-L', {
      hypothesisId: hypothesis.id,
      action: 'Ran minimal delimiter fixture',
      result: 'Failure reproduced only with nested delimiters',
      outcome: 'supported',
      lesson: 'Bug is isolated to nested delimiter lookahead'
    });
    assert.match(experiment.id, /^exp-/);

    const reloaded = new ProjectStore(dir);
    const state = await reloaded.getProject('NolQu-L');
    assert.equal(state.observations.length, 1);
    assert.equal(state.hypotheses.length, 1);
    assert.equal(state.experiments.length, 1);
    assert.equal(state.lessons.at(-1).text, 'Bug is isolated to nested delimiter lookahead');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects an invalid confidence score', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'astra-project-forge-store-'));
  try {
    const store = new ProjectStore(dir);
    await store.initializeProject({ projectId: 'x', goal: 'test' });
    await assert.rejects(
      () => store.addObservation('x', { observation: 'x', confidence: 1.5 }),
      /confidence/i
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
