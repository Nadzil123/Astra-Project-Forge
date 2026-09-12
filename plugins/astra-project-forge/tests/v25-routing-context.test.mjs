import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../server/state-store.mjs';
import { routeTask } from '../server/adaptive-router.mjs';

test('routes trivial work off and difficult long-horizon work deep', () => {
  const trivial = routeTask({
    complexity: 'simple', uncertainty: 'low', continuityNeeded: false,
    repeatedFailure: false, crossDomain: false
  });
  assert.equal(trivial.profile, 'off');
  assert.equal(trivial.cycleBudget, 0);
  assert.equal(trivial.stateDetail, 'none');

  const difficult = routeTask({
    complexity: 'complex', uncertainty: 'high', continuityNeeded: true,
    repeatedFailure: true, crossDomain: true,
    capabilityNeeds: ['repository', 'testing', 'review']
  });
  assert.equal(difficult.profile, 'deep');
  assert.ok(difficult.cycleBudget >= 4);
  assert.equal(difficult.stateDetail, 'working');
  assert.deepEqual(difficult.capabilityNeeds, ['repository', 'testing', 'review']);
});

test('returns a compact project context without dumping full history', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'astra-v25-context-'));
  const store = new ProjectStore(dir);
  try {
    await store.initializeProject({ projectId: 'p', goal: 'Ship reliable system', mode: 'deep' });
    for (let i = 0; i < 8; i++) {
      await store.addObservation('p', { observation: `observation-${i}`, evidence: `evidence-${i}` });
    }
    for (let i = 0; i < 6; i++) {
      await store.addHypothesis('p', { hypothesis: `hypothesis-${i}` });
    }
    await store.addCheckpoint('p', { summary: 'latest checkpoint', nextSteps: ['next'] });

    const summary = await store.getContext('p', { detail: 'summary', maxItems: 3 });
    assert.equal(summary.project.projectId, 'p');
    assert.equal(summary.counts.observations, 8);
    assert.equal(summary.latestCheckpoint.summary, 'latest checkpoint');
    assert.equal('observations' in summary, false);

    const working = await store.getContext('p', { detail: 'working', maxItems: 3 });
    assert.equal(working.observations.length, 3);
    assert.equal(working.observations.at(-1).observation, 'observation-7');
    assert.ok(working.hypotheses.length <= 3);

    const full = await store.getContext('p', { detail: 'full', maxItems: 3 });
    assert.equal(full.project.observations.length, 8);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
