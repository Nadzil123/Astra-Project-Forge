import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../server/state-store.mjs';

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'astra-v26-transfer-'));
  const store = new ProjectStore(dir);
  await store.initializeProject({ projectId: 'p', goal: 'Resume safely', successCriteria: ['verified'] });
  return { dir, store };
}

test('stores cross-project lessons as candidates until locally validated', async () => {
  const { dir, store } = await setup();
  try {
    const candidate = await store.addTransferCandidate('p', {
      sourceProjectId: 'old-project', lesson: 'Use a focused parser fixture before broad rewrites', relevance: 'Parser failure resembles earlier nested-delimiter bug'
    });
    assert.equal(candidate.status, 'candidate');
    await assert.rejects(() => store.validateTransferCandidate('p', candidate.id, []), /evidence/i);
    const validated = await store.validateTransferCandidate('p', candidate.id, ['obs-local-1']);
    assert.equal(validated.status, 'validated');
    assert.deepEqual(validated.validationEvidenceIds, ['obs-local-1']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('builds compact recovery context from latest checkpoint and open work', async () => {
  const { dir, store } = await setup();
  try {
    const goal = await store.addGoal('p', { parentId: 'goal-root', title: 'Unfinished work' });
    await store.addClaim('p', { statement: 'External permission is required', status: 'unknown' });
    await store.addCheckpoint('p', { summary: 'Stopped before external action', nextSteps: ['request permission'], remainingUnknowns: ['permission state'] });
    await store.addPlan('p', { goalId: goal.id, action: 'Request permission', why: 'Cannot proceed safely', risk: 'low', usageImpact: 'LOW' });
    await store.addAdaptation('p', {
      failureCategory: 'permission_limitation', failedAction: 'Use restricted capability',
      diagnosis: 'Host denied permission', nextStrategy: 'Request user permission before retrying'
    });

    const recovery = await store.getRecoveryContext('p');
    assert.equal(recovery.projectId, 'p');
    assert.equal(recovery.latestCheckpoint.summary, 'Stopped before external action');
    assert.ok(recovery.openGoals.some(item => item.id === goal.id));
    assert.ok(recovery.openClaims.some(item => item.status === 'unknown'));
    assert.equal(recovery.lastPlan.action, 'Request permission');
    assert.equal(recovery.lastAdaptation.failureCategory, 'permission_limitation');
    assert.equal('observations' in recovery, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
