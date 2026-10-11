import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rm, symlink, link } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { ProjectStore } from '../server/state-store.mjs';

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-persistence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ProjectStore(root);
  const project = await store.initializeProject({ projectId: 'p', goal: 'Preserve every writer' });
  const target = path.join(root, (await readdir(root)).find(name => name.endsWith('.json')));
  return { root, store, project, target };
}
function worker(t, mode, root, target, count) {
  const child = fork(new URL('./helpers/v262-persistence-worker.mjs', import.meta.url), [mode, root, target, String(count ?? 10)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => child.kill('SIGKILL'));
  const next = () => Promise.race([
    once(child, 'message').then(([message]) => message),
    once(child, 'exit').then(([code]) => { throw new Error(`Worker exited ${code}: ${stderr}`); }),
  ]);
  return { child, next };
}

// Removing whole read-modify-write exclusion loses observations/revisions.
test('store instances preserve every concurrent observation and unique revision', async t => {
  const { root, store } = await setup(t);
  const records = await Promise.all(Array.from({ length: 30 }, (_, i) => new ProjectStore(root).addObservation('p', { observation: `obs:${i}` })));
  const project = await store.getProject('p');
  assert.equal(project.observations.length, 30);
  assert.equal(project.revision, 31);
  assert.deepEqual(records.map(record => record.revision).sort((a,b) => a-b), Array.from({ length: 30 }, (_, i) => i + 2));
});

test('child process writers preserve all observations and commit revisions', async t => {
  const { root, store } = await setup(t);
  const writers = Array.from({ length: 3 }, (_, i) => worker(t, 'observe', root, `worker${i}`, 12));
  await Promise.all(writers.map(writer => writer.next()));
  const results = writers.map(writer => writer.next());
  writers.forEach(writer => writer.child.send('go'));
  const revisions = (await Promise.all(results)).flatMap(result => result.revisions);
  const project = await store.getProject('p');
  assert.equal(project.observations.length, 36);
  assert.equal(new Set(project.observations.map(item => item.observation)).size, 36);
  assert.equal(project.revision, 37);
  assert.deepEqual(revisions.sort((a,b) => a-b), Array.from({ length: 36 }, (_, i) => i + 2));
});

// Writing inside the callback, or awaiting a callback, would violate rollback.
test('throwing and async transactions preserve exact file bytes', async t => {
  const { store, target } = await setup(t);
  const before = await readFile(target);
  assert.equal(typeof store.transact, 'function');
  await assert.rejects(store.transact('p', project => { project.goal = 'discard'; throw new Error('abort'); }), /abort/);
  await assert.rejects(store.transact('p', async project => { project.goal = 'discard'; }), /synchronous|async/i);
  await assert.rejects(store.transact('p', project => { project.goal = 'discard'; return Promise.resolve(); }), /synchronous|async/i);
  assert.deepEqual(await readFile(target), before);
});

test('transaction returns its result and stamps one persisted revision', async t => {
  const { root, store } = await setup(t);
  assert.equal(typeof store.transact, 'function');
  const result = await store.transact('p', project => {
    project.observations.push({ id: 'explicit', observation: 'one commit' });
    project.constraints.push('binding constraint');
    return { accepted: true };
  });
  assert.deepEqual(result.result, { accepted: true });
  assert.equal(result.project.revision, 2);
  assert.equal(result.project.observations[0].revision, 2);
  assert.deepEqual(await new ProjectStore(root).getProject('p'), result.project);
});

test('migration serializes with mutations and saves original legacy bytes', async t => {
  const { root, store, target } = await setup(t);
  const legacy = JSON.parse(await readFile(target, 'utf8'));
  legacy.schemaVersion = 1;
  delete legacy.efficiency;
  const original = JSON.stringify(legacy);
  await writeFile(target, original);
  await Promise.all([new ProjectStore(root).getProject('p'), ...Array.from({ length: 10 }, (_, i) => store.addObservation('p', { observation: `migration:${i}` }))]);
  assert.equal((await store.getProject('p')).observations.length, 10);
  const backups = (await readdir(root)).filter(name => name.includes('.backup'));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(path.join(root, backups[0]), 'utf8'), original);
});

test('legacy transaction failure cannot trigger a migration', async t => {
  const { store, target } = await setup(t);
  const raw = JSON.parse(await readFile(target, 'utf8'));
  raw.schemaVersion = 1;
  delete raw.efficiency;
  await writeFile(target, JSON.stringify(raw));
  const before = await readFile(target);
  assert.equal(typeof store.transact, 'function');
  await assert.rejects(store.transact('p', () => { throw new Error('abort'); }), /abort/);
  assert.deepEqual(await readFile(target), before);
});

test('nested lock and store calls complete without deadlock', { timeout: 10000 }, async t => {
  const { store, target } = await setup(t);
  const { withProjectLock } = await import('../server/project-persistence.mjs');
  await withProjectLock(target, () => withProjectLock(target, () => store.addObservation('p', { observation: 'nested' })));
  assert.equal((await store.getProject('p')).observations.length, 1);
});

test('nested sibling store calls preserve all updates under an outer lock', async t => {
  const { root, store, target } = await setup(t);
  const { withProjectLock } = await import('../server/project-persistence.mjs');
  await withProjectLock(target, () => Promise.all(Array.from({ length: 15 }, (_, i) => new ProjectStore(root).addObservation('p', { observation: `nested:${i}` }))));
  assert.equal((await store.getProject('p')).observations.length, 15);
});

// A finished child's ALS context must not bypass a later sibling's admission.
test('delayed continuations from finished scopes cannot overlap a later sibling', { timeout: 10000 }, async t => {
  const { target } = await setup(t);
  const { withProjectLock } = await import('../server/project-persistence.mjs');
  let resume;
  let late;
  let insideSibling = false;
  let overlap = false;
  const gate = new Promise(resolve => { resume = resolve; });
  await withProjectLock(target, async () => {
    await withProjectLock(target, () => {
      // Handle either outcome immediately; the test releases B independently.
      late = gate.then(() => withProjectLock(target, () => { overlap = insideSibling; }))
        .then(() => ({ accepted: true }), error => ({ error }));
    });
    await withProjectLock(target, async () => {
      insideSibling = true;
      resume();
      // B also has an independent release deadline, so a serialized late
      // callback queued behind B cannot hang this regression test.
      let timer;
      try {
        await Promise.race([late, new Promise(resolve => { timer = setTimeout(resolve, 1000); })]);
      } finally { clearTimeout(timer); }
      insideSibling = false;
    });
    const outcome = await late;
    assert.equal(overlap, false, 'finished-child continuation overlapped the sibling');
    assert.equal(outcome.error?.code, 'PROJECT_LOCK_SCOPE_CLOSED');
  });
});

test('transactions cannot redirect writes to a different project', async t => {
  const { store, target } = await setup(t);
  await store.initializeProject({ projectId: 'other', goal: 'Other project' });
  const other = await store.getProject('other');
  const before = await readFile(target);
  await assert.rejects(store.transact('p', project => { project.projectId = 'other'; }), /projectId|identity/);
  assert.deepEqual(await readFile(target), before);
  assert.deepEqual(await store.getProject('other'), other);
});

test('same-process lock contention fails boundedly and cannot execute later', { timeout: 15000 }, async t => {
  const { target } = await setup(t);
  const { withProjectLock } = await import('../server/project-persistence.mjs');
  let release;
  let signal;
  const ready = new Promise(resolve => { signal = resolve; });
  const hold = withProjectLock(target, async () => { signal(); await new Promise(resolve => { release = resolve; }); });
  await ready;
  let executed = false;
  try {
    await assert.rejects(withProjectLock(target, () => { executed = true; }), error => error.code === 'PROJECT_LOCK_CONFLICT');
  } finally { release(); await hold; }
  // A timed-out queued writer must not run when its predecessor releases.
  await withProjectLock(target, () => {});
  assert.equal(executed, false);
});

test('symlink directory aliases share the critical section', async t => {
  const { root, store } = await setup(t);
  const alias = `${root}-alias`;
  await symlink(root, alias, 'dir');
  t.after(() => rm(alias, { force: true }));
  await Promise.all(Array.from({ length: 20 }, (_, i) => new ProjectStore(i % 2 ? root : alias).addObservation('p', { observation: `alias:${i}` })));
  assert.equal((await store.getProject('p')).observations.length, 20);
  assert.equal((await store.getProject('p')).revision, 21);
});

for (const mode of ['hold', 'write']) {
  test(`interrupted ${mode} owner recovers without stealing a live lock`, { timeout: 15000 }, async t => {
    const { root, store, target } = await setup(t);
    const holder = worker(t, mode, root, target);
    await holder.next();
    if (mode === 'write') {
      const working = holder.next();
      holder.child.send('prepare');
      assert.deepEqual(await working, { working: true });
    }
    const pending = store.addObservation('p', { observation: 'after recovery' });
    // Hold dies before work; write dies after in-memory work, before publishing.
    const exited = once(holder.child, 'exit');
    holder.child.kill('SIGKILL');
    await exited;
    await pending;
    assert.deepEqual((await store.getProject('p')).observations.map(item => item.observation), ['after recovery']);
  });
}

test('competing process recoverers cannot unlink a successor lock', { timeout: 15000 }, async t => {
  const { root, store, target } = await setup(t);
  const holder = worker(t, 'hold', root, target);
  await holder.next();
  const writers = Array.from({ length: 4 }, (_, i) => worker(t, 'observe', root, `recovery${i}`, 12));
  await Promise.all(writers.map(writer => writer.next()));
  const results = writers.map(writer => writer.next());
  writers.forEach(writer => writer.child.send('go'));
  const exited = once(holder.child, 'exit');
  holder.child.kill('SIGKILL');
  await exited;
  await Promise.all(results);
  assert.equal((await store.getProject('p')).observations.length, 48);
  assert.equal((await store.getProject('p')).revision, 49);
});

test('dead recovery guard conflicts boundedly without touching a live successor', { timeout: 15000 }, async t => {
  const { root, store, target } = await setup(t);
  const old = worker(t, 'hold', root, target);
  await old.next();
  await link(`${target}.lock`, `${target}.dead-recovery-owner`);
  const exited = once(old.child, 'exit');
  old.child.kill('SIGKILL');
  await exited;
  const successor = worker(t, 'hold', root, target);
  await successor.next();
  // A process interrupted inside cleanup can leave its immutable recovery guard.
  await link(`${target}.dead-recovery-owner`, `${target}.lock.recovery`);
  const lockBefore = await readFile(`${target}.lock`);
  const before = await readFile(target);
  await assert.rejects(store.addObservation('p', { observation: 'must not run' }), error => error.code === 'PROJECT_LOCK_CONFLICT');
  assert.deepEqual(await readFile(`${target}.lock`), lockBefore);
  assert.deepEqual(await readFile(target), before);
  successor.child.send('release');
});

test('an owner from an unrecognized procfs view is never declared dead', { timeout: 10000, skip: process.platform !== 'linux' }, async t => {
  const { store, target } = await setup(t);
  const owner = { id: 'foreign-owner', pid: 99999999, host: hostname(), boot: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(), start: '1', procDevice: 'unrecognized-proc-mount' };
  const bytes = JSON.stringify(owner);
  await writeFile(`${target}.lock`, bytes);
  const before = await readFile(target);
  await assert.rejects(store.addObservation('p', { observation: 'must not steal' }), error => error.code === 'PROJECT_LOCK_CONFLICT');
  assert.equal(await readFile(`${target}.lock`, 'utf8'), bytes);
  assert.deepEqual(await readFile(target), before);
});

test('a live lock waits for release and cannot be stolen', { timeout: 15000 }, async t => {
  const { root, store, target } = await setup(t);
  const holder = worker(t, 'hold', root, target);
  await holder.next();
  let finished = false;
  const pending = store.addObservation('p', { observation: 'after live owner' }).then(() => { finished = true; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(finished, false);
  holder.child.send('release');
  await pending;
});

test('atomic JSON writes expose complete snapshots and clean owned temporary files', async t => {
  const { target, root } = await setup(t);
  const { atomicWriteJSON } = await import('../server/project-persistence.mjs');
  const sentinel = `${target}.foreign.tmp`;
  await writeFile(sentinel, 'other writer');
  await Promise.all(Array.from({ length: 15 }, (_, i) => atomicWriteJSON(target, { i, payload: 'x'.repeat(10000) })));
  const snapshot = JSON.parse(await readFile(target, 'utf8'));
  assert.equal(snapshot.payload, 'x'.repeat(10000));
  assert.equal(await readFile(sentinel, 'utf8'), 'other writer');
  assert.deepEqual((await readdir(root)).filter(name => name.endsWith('.tmp')), [path.basename(sentinel)]);
});
