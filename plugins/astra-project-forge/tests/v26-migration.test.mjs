import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ProjectStore } from '../server/state-store.mjs';

function safeFilename(projectId) {
  const clean = projectId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'project';
  const hash = createHash('sha256').update(projectId).digest('hex').slice(0, 12);
  return `${clean}-${hash}.json`;
}

test('migrates v1 project state to schema v2 without losing existing data', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'astra-v26-migration-'));
  try {
    const projectId = 'legacy-project';
    const legacy = {
      schemaVersion: 1,
      projectId,
      goal: 'Ship the legacy project safely',
      mode: 'deep',
      successCriteria: ['all tests pass'],
      constraints: ['preserve behavior'],
      status: 'active',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
      observations: [{ id: 'obs-1', observation: 'legacy fact', evidence: 'legacy test', confidence: 0.9, createdAt: '2026-09-01T01:00:00.000Z' }],
      hypotheses: [{ id: 'hyp-1', hypothesis: 'legacy hypothesis', test: null, confidence: 0.5, status: 'open', createdAt: '2026-09-01T02:00:00.000Z' }],
      experiments: [],
      checkpoints: [],
      lessons: [{ id: 'lesson-1', text: 'legacy lesson', sourceExperimentId: null, createdAt: '2026-09-01T03:00:00.000Z' }],
      consolidation: null
    };
    await writeFile(path.join(dir, safeFilename(projectId)), `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');

    const store = new ProjectStore(dir);
    const migrated = await store.getProject(projectId);

    assert.equal(migrated.schemaVersion, 2);
    assert.equal(migrated.observations.length, 1);
    assert.equal(migrated.hypotheses.length, 1);
    assert.equal(migrated.lessons.length, 1);
    assert.equal(migrated.goalGraph.length, 1);
    assert.equal(migrated.goalGraph[0].parentId, null);
    assert.equal(migrated.goalGraph[0].title, legacy.goal);
    assert.equal(migrated.goalGraph[0].status, 'active');
    assert.deepEqual(migrated.claims, []);
    assert.deepEqual(migrated.plans, []);
    assert.deepEqual(migrated.evaluations, []);
    assert.deepEqual(migrated.transferCandidates, []);
    assert.deepEqual(migrated.usage, {
      lastProfile: 'off',
      lastUsageImpact: 'MINIMAL',
      firstUseNoticeAcknowledged: false,
      deepWarningAcknowledged: false
    });

    const persisted = JSON.parse(await readFile(path.join(dir, safeFilename(projectId)), 'utf8'));
    assert.equal(persisted.schemaVersion, 2);
    assert.equal(persisted.goalGraph.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('initializes new projects directly with schema v2 state', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'astra-v26-new-'));
  try {
    const store = new ProjectStore(dir);
    const project = await store.initializeProject({ projectId: 'new-project', goal: 'Build v2 state' });
    assert.equal(project.schemaVersion, 2);
    assert.equal(project.goalGraph.length, 1);
    assert.equal(project.goalGraph[0].title, 'Build v2 state');
    assert.deepEqual(project.claims, []);
    assert.deepEqual(project.plans, []);
    assert.deepEqual(project.evaluations, []);
    assert.deepEqual(project.transferCandidates, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
