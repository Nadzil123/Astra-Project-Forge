import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../server/state-store.mjs';

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'astra-v26-claims-'));
  const store = new ProjectStore(dir);
  await store.initializeProject({ projectId: 'p', goal: 'Reason carefully' });
  return { dir, store };
}

test('known claims require evidence', async () => {
  const { dir, store } = await setup();
  try {
    await assert.rejects(() => store.addClaim('p', { statement: 'Fact', status: 'known' }), /evidence/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('stores inferred claims separately from known facts and retains contradictions', async () => {
  const { dir, store } = await setup();
  try {
    const claim = await store.addClaim('p', { statement: 'The parser bug is in lookahead', status: 'inferred', confidence: 0.6 });
    assert.equal(claim.status, 'inferred');
    const contradicted = await store.updateClaim('p', claim.id, { status: 'contradicted', counterEvidenceIds: ['obs-counter'] });
    assert.equal(contradicted.status, 'contradicted');
    assert.deepEqual(contradicted.counterEvidenceIds, ['obs-counter']);
    assert.equal(contradicted.statement, claim.statement);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('validates claim confidence bounds', async () => {
  const { dir, store } = await setup();
  try {
    await assert.rejects(() => store.addClaim('p', { statement: 'Bad confidence', confidence: 1.1 }), /confidence/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
