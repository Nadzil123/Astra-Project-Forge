import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../server/state-store.mjs';
import { getStateIdentity } from '../server/coordination-core.mjs';

async function api() {
  assert.equal(typeof ProjectStore.prototype.getReferences, 'function', 'scoped reference expansion must exist');
  return import('../server/state-references.mjs');
}
async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-references-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ProjectStore(root);
  const project = await store.initializeProject({ projectId: 'p', goal: 'Verify' });
  const target = path.join(root, (await readdir(root)).find(name => name.endsWith('.json')));
  return { store, project, target };
}

// Break caught: using the project commit revision instead of the record stamp,
// or replacing the canonical evidence key with evidenceId metadata.
test('references use per-record revisions and canonical evidence cache identities', async t => {
  const { store, project } = await setup(t); const { makeStateRef } = await api();
  const goalRef = makeStateRef(project, 'goal', project.goalGraph[0]);
  await store.addObservation('p', { observation: 'Unrelated' });
  const current = await store.getProject('p');
  assert.deepEqual(makeStateRef(current, 'goal', current.goalGraph[0]), goalRef);
  const evidence = await store.upsertEvidenceRecord('p', { evidenceId: 'metadata', kind: 'test', target: 'source',
    dependencies: ['v1'], dependencyIds: ['source'], freshness: 'fresh', result: { passed: true } });
  const ref = makeStateRef(await store.getProject('p'), 'evidence', evidence);
  assert.equal(ref.id, evidence.key); assert.notEqual(ref.id, 'metadata');
  assert.equal(ref.revision, evidence.revision); assert.equal(ref.projectId, 'p');
});

// Break caught: losing stored provenance during expansion or treating an exact
// requested version as a current-only lookup.
test('exact references expand original records with provenance without writing state', async t => {
  const { store, target } = await setup(t); const { makeStateRef } = await api();
  const observation = await store.recordObservation('p', { observation: 'Observed', evidence: 'runner log',
    evidenceRecord: { evidenceId: 'e1', kind: 'test', target: 'source', dependencies: ['v1'], dependencyIds: ['source'],
      freshness: 'fresh', provenance: { source: 'reported', reference: 'run:17' }, result: { passed: false } } });
  const project = await store.getProject('p');
  const ref = makeStateRef(project, 'evidence', observation.evidenceRecord);
  const before = await readFile(target);
  const expanded = await store.getReferences('p', [ref]);
  assert.deepEqual(expanded.identity, getStateIdentity(project));
  assert.equal(expanded.references[0].status, 'unchanged');
  assert.deepEqual(expanded.references[0].record, observation.evidenceRecord);
  assert.deepEqual(expanded.references[0].record.provenance, { source: 'reported', reference: 'run:17' });
  assert.deepEqual(expanded.references[0].ref, ref);
  assert.deepEqual(await readFile(target), before);
});

// Break caught: returning the latest data as though it were a requested old
// version, and ignoring invalidation as a record change.
test('invalidation makes old evidence references stale with explicitly current fields', async t => {
  const { store } = await setup(t); const { makeStateRef } = await api();
  const evidence = await store.upsertEvidenceRecord('p', { evidenceId: 'e1', kind: 'test', target: 'source',
    dependencies: ['v1'], dependencyIds: ['source'], freshness: 'fresh' });
  const ref = makeStateRef(await store.getProject('p'), 'evidence', evidence);
  await store.invalidateEvidence('p', ['source']);
  const [entry] = (await store.getReferences('p', [ref])).references;
  assert.equal(entry.status, 'stale'); assert.deepEqual(entry.reference, ref);
  assert.equal(entry.record, undefined); assert.equal(entry.ref, undefined);
  assert.equal(entry.currentRecord.freshness, 'stale');
  assert.equal(entry.currentRef.id, ref.id); assert.ok(entry.currentRef.revision > ref.revision);
});

// Break caught: fabricating a removed version or leaking records across scopes.
test('missing, deleted, future, malformed and foreign references receive explicit statuses', async t => {
  const { store, project } = await setup(t); const { makeStateRef } = await api();
  const ref = makeStateRef(project, 'goal', project.goalGraph[0]);
  const entries = (await store.getReferences('p', [
    { ...ref, id: 'deleted' }, { ...ref, revision: ref.revision + 20 },
    { ...ref, projectId: 'foreign' }, { ...ref, epoch: 'foreign' }, { ...ref, revision: -1 }, null,
  ])).references;
  assert.deepEqual(entries.map(entry => entry.status), ['not_found', 'stale', 'scope_mismatch', 'scope_mismatch', 'not_found', 'not_found']);
  for (const index of [0, 2, 3, 4, 5]) {
    assert.equal(entries[index].record, undefined); assert.equal(entries[index].currentRecord, undefined);
  }
  assert.equal(entries[0].reference.id, 'deleted');
});

test('reset changes epoch and refuses an earlier generation reference', async t => {
  const { store, project } = await setup(t); const { makeStateRef } = await api();
  const ref = makeStateRef(project, 'goal', project.goalGraph[0]);
  await store.initializeProject({ projectId: 'p', goal: 'New generation' });
  const result = await store.getReferences('p', [ref]);
  assert.notEqual(result.identity.epoch, ref.epoch);
  assert.equal(result.references[0].status, 'scope_mismatch');
  assert.equal(result.references[0].currentRecord, undefined);
});

// Break caught: omitting an existing resolvable section, silently giving string
// lessons synthetic identities, or failing optional-revision current lookup.
test('all resolvable record kinds expand exactly and omitted revisions request current data', async () => {
  const { makeStateRef, resolveStateReferences } = await api();
  const project = { projectId: 'p', coordination: { epoch: 'generation' }, revision: 50,
    goalGraph: [{ id: 'g', revision: 2 }], claims: [{ id: 'c', revision: 3 }], plans: [{ id: 'p', revision: 4 }],
    evaluations: [{ id: 'ev', revision: 5 }], observations: [{ id: 'o', revision: 6 }],
    checkpoints: [{ id: 'cp', revision: 7 }], adaptations: [{ id: 'a', revision: 8 }],
    transferCandidates: [{ id: 't', revision: 9 }], lessons: ['legacy', { id: 'l', revision: 10 }],
    hypotheses: [{ id: 'h', revision: 11 }], experiments: [{ id: 'x', revision: 12 }],
    efficiency: { evidenceCache: [{ key: 'canonical', evidenceId: 'metadata', revision: 13 }],
      failedStrategies: [{ id: 'f', revision: 14 }] } };
  const groups = [['goal', project.goalGraph], ['claim', project.claims], ['plan', project.plans],
    ['evaluation', project.evaluations], ['observation', project.observations], ['checkpoint', project.checkpoints],
    ['adaptation', project.adaptations], ['transfer', project.transferCandidates], ['lesson', [project.lessons[1]]],
    ['hypothesis', project.hypotheses], ['experiment', project.experiments],
    ['evidence', project.efficiency.evidenceCache], ['failedStrategy', project.efficiency.failedStrategies]];
  for (const [kind, records] of groups) {
    const ref = makeStateRef(project, kind, records[0]);
    assert.equal(ref.revision, records[0].revision);
    const [exact] = resolveStateReferences(project, [ref]).references;
    assert.equal(exact.status, 'unchanged'); assert.deepEqual(exact.record, records[0]);
    const { revision, ...currentRequest } = ref;
    assert.equal(resolveStateReferences(project, [currentRequest]).references[0].status, 'current');
  }
  assert.throws(() => makeStateRef(project, 'lesson', 'legacy'), /identity|record/i);
  assert.throws(() => makeStateRef(project, 'unsupported', { id: 'x' }), /kind/i);
});

test('new readers never persist normalization of legacy state', async t => {
  const { store, target } = await setup(t); await api();
  const legacy = { projectId: 'p', goal: 'Old goal', createdAt: '2020-01-01', schemaVersion: 1 };
  await writeFile(target, JSON.stringify(legacy)); const before = await readFile(target);
  const refs = await store.getReferences('p', []);
  assert.match(refs.identity.epoch, /^legacy-/);
  await store.getDecisionCapsule('p');
  assert.deepEqual(await readFile(target), before);
});
