import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ProjectStore } from '../server/state-store.mjs';
import { routingFixture } from './helpers/model-routing-fixtures.mjs';
import { getStateIdentity } from '../server/coordination-core.mjs';

const fixtureRoot = fileURLToPath(new URL('./fixtures/v262-routing-baseline/', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
// Pin independently of the manifest so editing bytes + manifest cannot redefine the baseline.
const provenanceDigest = 'f59131ad7881f1515d13b553bc6423eee46941a7f2232aa32f1f478765811edc';
const provenanceBytes = await readFile(path.join(fixtureRoot, 'provenance.json'));
assert.equal(sha256(provenanceBytes), provenanceDigest, 'baseline provenance digest');
const provenance = JSON.parse(provenanceBytes);

async function validateBaseline(root) {
  for (const [file, digest] of Object.entries(provenance.files)) {
    assert.equal(sha256(await readFile(path.join(root, file))), digest, `baseline mismatch: ${file}`);
  }
  return root;
}
const baselineRoot = await validateBaseline(Object.hasOwn(process.env, 'FORGE_ROUTING_BASELINE_ROOT')
  ? path.resolve(process.env.FORGE_ROUTING_BASELINE_ROOT) : fixtureRoot);
const { ProjectStore: LegacyStore } = await import(pathToFileURL(path.join(baselineRoot, 'server/state-store.mjs')));

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-model-compat-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ProjectStore(root);
  const project = await store.initializeProject({ projectId: 'p', goal: 'Keep rollback readable', constraints: ['Keep evidence'] });
  const target = path.join(root, (await readdir(root)).find(name => name.endsWith('.json')));
  const { request, runtime } = routingFixture(); request.expectedState = getStateIdentity(project);
  return { root, store, target, runtime, args: { modelRouting: request } };
}

test('portable fixture verifies all pinned bytes and rejects an altered override', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-baseline-copy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(fixtureRoot, root, { recursive: true });
  await validateBaseline(root);
  const { ProjectStore: CopiedStore } = await import(pathToFileURL(path.join(root, 'server/state-store.mjs')));
  const store = new CopiedStore(path.join(root, 'data'));
  assert.equal((await store.initializeProject({ projectId: 'copy', goal: 'Portable baseline' })).schemaVersion, 2);
  await writeFile(path.join(root, 'server/state-store.mjs'), '// modified baseline\n');
  await assert.rejects(validateBaseline(root), /baseline mismatch/);
  await assert.rejects(validateBaseline(path.join(root, 'missing')), /ENOENT/);
});

test('old reader preserves optional routing state graph and unknown v1 fields after legacy write', async t => {
  const { root, store, args, runtime, target } = await setup(t);
  await store.upsertEvidenceRecord('p', { evidenceId: 'source-check', kind: 'test', target: 'source preservation',
    dependencies: ['source:v1'], dependencyIds: ['source'], freshness: 'fresh', result: { synthetic: true } });
  await store.addClaim('p', { statement: 'Source check is recorded', status: 'known', evidenceIds: ['source-check'] });
  args.modelRouting.expectedState = getStateIdentity(await store.getProject('p'));
  await store.routeProjectWithModelAdvice('p', args, runtime);
  await store.transact('p', project => {
    project.sentinel = { future: ['keep'] };
    project.goalGraph[0].futureGoalField = 'keep goal';
    project.modelRouting.futureExtension = { keep: true };
    project.modelRouting.decisions[0].futureDecision = 'keep decision';
    project.modelRouting.decisions[0].advice.futureAdvice = 'keep advice';
    project.modelRouting.operations['route-1'].futureReceipt = 'keep receipt';
    project.modelRouting.operations['route-1'].response.modelAdvice.futureAdvice = 'keep response';
  });
  const before = await store.getProject('p');
  const legacy = new LegacyStore(root);
  assert.deepEqual((await legacy.getProject('p')).modelRouting, before.modelRouting);
  await legacy.routeProject('p', { complexity: 'simple' });
  await legacy.addObservation('p', { observation: 'legacy reader can continue' });
  const after = await store.getProject('p');
  assert.equal(after.schemaVersion, 2);
  assert.equal(after.coordination.epoch, before.coordination.epoch);
  assert.deepEqual(after.goalGraph, before.goalGraph);
  assert.deepEqual(after.claims, before.claims);
  assert.deepEqual(after.efficiency.evidenceCache, before.efficiency.evidenceCache);
  assert.deepEqual(after.sentinel, before.sentinel);
  assert.deepEqual(after.modelRouting, before.modelRouting);
  const bytes = await readFile(target);
  const replay = await store.routeProjectWithModelAdvice('p', args, runtime);
  assert.equal(replay.replayed, true);
  assert.equal(replay.identity.revision, 4);
  assert.equal(replay.modelAdvice.futureAdvice, 'keep response');
  assert.deepEqual(await readFile(target), bytes);
  const next = await store.routeProjectWithModelAdvice('p', { ...args, modelRouting: {
    ...args.modelRouting, operationId: 'route-2', expectedState: getStateIdentity(after),
  } }, runtime);
  const continued = await store.getProject('p');
  assert.equal(next.identity.revision, after.revision + 1);
  assert.deepEqual(continued.modelRouting.futureExtension, before.modelRouting.futureExtension);
  assert.deepEqual(continued.modelRouting.decisions[0], before.modelRouting.decisions[0]);
  assert.deepEqual(continued.modelRouting.operations['route-1'], before.modelRouting.operations['route-1']);
});

test('unsupported extension remains intact under legacy reads and writes but rejects opt-in', async t => {
  const { root, store, target, args, runtime } = await setup(t);
  const raw = JSON.parse(await readFile(target, 'utf8'));
  const extension = { version: 99, future: { opaque: [1, 'keep'] } };
  await writeFile(target, JSON.stringify({ ...raw, modelRouting: extension }));
  const legacy = new LegacyStore(root);
  assert.deepEqual((await legacy.getProject('p')).modelRouting, extension);
  await legacy.routeProject('p', { complexity: 'simple' });
  assert.deepEqual((await store.getProject('p')).modelRouting, extension);
  const bytes = await readFile(target);
  await assert.rejects(store.routeProjectWithModelAdvice('p', args, runtime), /version|extension/i);
  assert.deepEqual(await readFile(target), bytes);
});

test('feature-off reads and legacy routing never create an absent extension', async t => {
  const { root, store, target } = await setup(t);
  const before = await readFile(target);
  assert.equal(Object.hasOwn(await store.getProject('p'), 'modelRouting'), false);
  assert.equal(Object.hasOwn(await new LegacyStore(root).getProject('p'), 'modelRouting'), false);
  assert.deepEqual(await readFile(target), before);
  await store.routeProject('p', { complexity: 'simple' });
  assert.equal(Object.hasOwn(await store.getProject('p'), 'modelRouting'), false);
});
