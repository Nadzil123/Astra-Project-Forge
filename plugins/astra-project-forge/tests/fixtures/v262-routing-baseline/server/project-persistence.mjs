import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

// Local filesystem, single host only. Hardlinks provide exclusive publication of
// complete owner metadata, including when a process dies during acquisition.
// Linux boot/start identities distinguish a dead owner from a reused PID. Other
// platforms never recover an owner they cannot prove dead. Waiting is bounded;
// elapsed time is never evidence that a lock owner is dead.
const WAIT_MS = 5000;
const scopes = new AsyncLocalStorage();
const queues = new Map();

async function canonical(filePath) {
  const resolved = path.resolve(filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  return path.join(await realpath(path.dirname(resolved)), path.basename(resolved));
}

async function processIdentity(pid) {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  // The command field can contain spaces or parentheses.
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
}

async function ownerIdentity() {
  const identity = { id: randomUUID(), pid: process.pid, host: hostname() };
  if (process.platform === 'linux') {
    try {
      identity.boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
      // /proc can be mounted from an ancestor PID namespace. Its self record
      // supplies the PID visible through that mount, unlike process.pid.
      const self = await readFile('/proc/self/stat', 'utf8');
      identity.pid = Number(self.slice(0, self.indexOf(' ')));
      identity.start = self.slice(self.lastIndexOf(')') + 2).split(' ')[19];
      // A procfs superblock belongs to a PID namespace. Match the mounted
      // device before interpreting absence of a PID in another process view.
      identity.procDevice = String((await stat('/proc')).dev);
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error;
      // Exclusion still works without procfs; recovery cannot prove death.
      delete identity.boot;
      delete identity.start;
    }
  }
  return identity;
}

async function provedDead(owner) {
  if (!owner || owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
    || typeof owner.id !== 'string' || !owner.boot || !owner.start || !owner.procDevice || process.platform !== 'linux') return false;
  try {
    if (owner.procDevice !== String((await stat('/proc')).dev)) return false;
    if (owner.boot !== (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()) return true;
  } catch (error) {
    // Missing namespace/boot data is uncertainty, not proof of death.
    return false;
  }
  try { return await processIdentity(owner.pid) !== owner.start; }
  catch (error) {
    return error.code === 'ENOENT';
  }
}

async function readOwner(filePath) {
  try { return JSON.parse(await readFile(filePath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) return {};
    throw error;
  }
}

async function removeOwn(filePath) {
  try { await unlink(filePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    // Directory fsync is unsupported on some OS/filesystem combinations.
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES', 'EBADF'].includes(error.code)) throw error;
  } finally { await handle?.close(); }
}

export async function backupProjectFile(filePath) {
  const target = await canonical(filePath);
  const bytes = await readFile(target);
  const backup = `${target}.${randomUUID()}.backup`;
  const handle = await open(backup, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  // Flush the backup's directory entry before publishing migrated state.
  await syncDirectory(path.dirname(target));
  return backup;
}

export async function atomicWriteJSON(filePath, value) {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  const target = await canonical(filePath);
  const temp = `${target}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(bytes, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temp, target);
    await syncDirectory(path.dirname(target));
  } finally {
    await handle?.close();
    await removeOwn(temp);
  }
}

async function recover(lockPath, candidate) {
  const observed = await readOwner(lockPath);
  if (!await provedDead(observed)) return;
  const guard = `${lockPath}.recovery`;
  try { await link(candidate, guard); }
  catch (error) { if (error.code === 'EEXIST') return; throw error; }
  try {
    // Recheck under the guard. Every cleaner obeys it, so a later lock owner
    // cannot be removed by a cleaner that inspected the earlier dead owner.
    const current = await readOwner(lockPath);
    if (current?.id === observed.id && await provedDead(current)) await removeOwn(lockPath);
  } finally { await removeOwn(guard); }
  // A process killed with this guard leaves conservative lock conflicts. Never
  // reclaim the guard: doing so would reintroduce the successor-unlink race.
}

function conflict(target) {
  const error = new Error(`Project lock conflict: timed out waiting for ${target}; owner may be live or require manual recovery`);
  error.code = 'PROJECT_LOCK_CONFLICT';
  return error;
}

async function acquire(target, deadline) {
  const lockPath = `${target}.lock`;
  const identity = await ownerIdentity();
  const candidate = `${lockPath}.${identity.id}.owner`;
  let handle;
  try {
    handle = await open(candidate, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(identity));
    await handle.sync();
    await handle.close();
    handle = null;
    while (true) {
      // Recovery holds its guard through unlink/recheck. New writers wait for
      // the guard too; a dead recovery guard requires manual intervention.
      if (!await readOwner(`${lockPath}.recovery`)) {
        try {
          await link(candidate, lockPath);
          return async () => {
            // Only this owner removes the acquired lock. Recovery is forbidden
            // while this process identity remains alive.
            try { await removeOwn(lockPath); } finally { await removeOwn(candidate); }
          };
        } catch (error) { if (error.code !== 'EEXIST') throw error; }
        await recover(lockPath, candidate);
      }
      if (Date.now() >= deadline) {
        throw conflict(target);
      }
      await delay(10 + Math.floor(Math.random() * 15));
    }
  } catch (error) {
    await handle?.close();
    await removeOwn(candidate);
    throw error;
  }
}

function enqueue(queue, work) {
  const pending = queue.tail.then(work, work);
  queue.tail = pending.catch(() => {});
  return pending;
}

function boundedQueue(queue, target, work, settled = () => {}) {
  let expired = false;
  let timer;
  const deadline = Date.now() + WAIT_MS;
  const pending = enqueue(queue, async () => {
    if (expired) throw conflict(target);
    return work(() => {
      if (expired) throw conflict(target);
      clearTimeout(timer);
    }, deadline);
  });
  // Queue accounting lasts until the actual queued operation settles, even
  // after its caller times out. Expired queued operations never execute work.
  pending.then(settled, settled);
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => { expired = true; reject(conflict(target)); }, WAIT_MS);
  });
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
}

async function runScope(target, parent, root, work) {
  const scope = { root, active: true, tail: Promise.resolve() };
  const inherited = new Map(parent ?? []);
  inherited.set(target, scope);
  return scopes.run(inherited, async () => {
    try { return await work(); }
    finally {
      // ALS continuations retain this object after their originating callback
      // returns. Close admission before draining already admitted descendants;
      // otherwise a finished child's queue can bypass its later siblings.
      scope.active = false;
      await scope.tail;
    }
  });
}

export async function withProjectLock(filePath, asyncWork) {
  if (typeof asyncWork !== 'function') throw new TypeError('Lock work must be a function');
  const target = await canonical(filePath);
  const parent = scopes.getStore();
  const inherited = parent?.get(target);
  if (inherited?.root.active) {
    if (!inherited.active) {
      const error = new Error(`Project lock scope closed: delayed work must enter from a current scope for ${target}`);
      error.code = 'PROJECT_LOCK_SCOPE_CLOSED';
      throw error;
    }
    // Sibling nested operations serialize, while each child has its own queue
    // for deeper reentrant calls. Awaiting a descendant cannot deadlock itself.
    return boundedQueue(inherited, target, entered => {
      entered();
      return runScope(target, parent, inherited.root, asyncWork);
    });
  }
  let queue = queues.get(target);
  if (!queue) { queue = { tail: Promise.resolve(), count: 0 }; queues.set(target, queue); }
  queue.count++;
  return boundedQueue(queue, target, async (entered, deadline) => {
      const release = await acquire(target, deadline);
      const root = { active: true };
      try {
        entered();
        return await runScope(target, parent, root, asyncWork);
      }
      finally { root.active = false; await release(); }
    }, () => {
    if (--queue.count === 0) queues.delete(target);
    });
}
