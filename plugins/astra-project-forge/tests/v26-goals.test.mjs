import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../server/state-store.mjs';

async function withStore(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'astra-v26-goals-'));
  try {
    const store = new ProjectStore(dir);
    await store.initializeProject({ projectId: 'p', goal: 'Ship v2.6', successCriteria: ['release verified'] });
    await fn(store);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('creates subgoals and blocks goals with unresolved dependencies', async () => {
  await withStore(async store => {
    const first = await store.addGoal('p', { parentId: 'goal-root', title: 'Implement state migration', priority: 80 });
    const second = await store.addGoal('p', { parentId: 'goal-root', title: 'Package release', dependencies: [first.id], priority: 60 });
    assert.equal(first.parentId, 'goal-root');
    assert.equal(first.status, 'pending');
    assert.equal(second.status, 'blocked');
    const goals = await store.getGoals('p');
    assert.equal(goals.length, 3);
  });
});

test('rejects invalid parent and dependency references', async () => {
  await withStore(async store => {
    await assert.rejects(() => store.addGoal('p', { parentId: 'missing', title: 'bad' }), /parent/i);
    await assert.rejects(() => store.addGoal('p', { parentId: 'goal-root', title: 'bad', dependencies: ['missing'] }), /dependenc/i);
  });
});

test('requires evidence before a goal can be marked verified and unblocks dependents after verification', async () => {
  await withStore(async store => {
    const first = await store.addGoal('p', { parentId: 'goal-root', title: 'Implement core' });
    const second = await store.addGoal('p', { parentId: 'goal-root', title: 'Release', dependencies: [first.id] });
    await assert.rejects(() => store.updateGoal('p', first.id, { status: 'verified' }), /evidence/i);
    const verified = await store.updateGoal('p', first.id, { status: 'verified', evidenceIds: ['eval-1'] });
    assert.equal(verified.status, 'verified');
    const goals = await store.getGoals('p');
    assert.equal(goals.find(g => g.id === second.id).status, 'pending');
  });
});
