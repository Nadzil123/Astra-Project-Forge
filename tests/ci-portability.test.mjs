import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const moduleURL = new URL('../.github/scripts/verify-portability.mjs', import.meta.url);
const names = ['forge_route', 'forge_goal', 'forge_context', 'forge_observe', 'forge_plan',
  'forge_evaluate', 'forge_adapt', 'forge_checkpoint', 'forge_consolidate', 'adaptive_route_task',
  'adaptive_get_context', 'adaptive_initialize_project', 'adaptive_get_state', 'adaptive_list_projects',
  'adaptive_record_observation', 'adaptive_record_hypothesis', 'adaptive_record_experiment',
  'adaptive_checkpoint', 'adaptive_consolidate'];
const hash = value => createHash('sha256').update(value).digest('hex');
// A deterministic transport fixture, never the unfinished plugin or a full-suite substitute.
const transport = `import readline from 'node:readline';
const names = ${JSON.stringify(names)};
const on = process.env.ASTRA_FORGE_MODEL_ROUTING === 'advisory-v1';
for await (const line of readline.createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (!m.id) continue;
  let result;
  if (m.method === 'initialize') result = { protocolVersion: '2025-06-18',
    serverInfo: { name: 'astra-project-forge', version: '0.0.0-fixture' },
    capabilities: { tools: { listChanged: false }, ...(on ? { experimental: { modelRouting: { version: 1, mode: 'advisory-v1' } } } : {}) } };
  if (m.method === 'tools/list') result = { tools: names.map(name => ({ name, inputSchema: { type: 'object', properties:
    name === 'forge_route' && on ? { modelRouting: { type: 'object' } } : {} } })) };
  console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
}
`;
const files = {
  'package.json': JSON.stringify({ name: 'portability-fixture-only', version: '0.0.0-fixture', license: 'AGPL-3.0-only',
    scripts: { check: 'fixture check', test: 'fixture complete test', 'benchmark:efficiency': 'fixture efficiency',
      'benchmark:routing:self-test': 'fixture routing self-test' } }),
  // Reuse only immutable legal bytes; no product modules or Task6 code execute.
  ...Object.fromEntries(['LICENSE', 'NOTICE.md', 'ATTRIBUTION.md'].map(name =>
    [name, readFileSync(new URL(`../plugins/astra-project-forge/${name}`, import.meta.url), 'utf8')])),
  'server/mcp-server.mjs': transport, 'nested/source.txt': 'exact committed source\n',
};

function git(repository, args, input) {
  const result = spawnSync('git', ['-C', repository, ...args], { input, encoding: 'utf8',
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'CI Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'CI Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(t, overrides = {}) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'forge-portability-unit-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const repository = path.join(temporary, 'objects.git');
  mkdirSync(repository);
  git(repository, ['init', '--bare', '--quiet']);
  const all = { ...files, ...overrides };
  function tree(entries) {
    const children = new Map();
    for (const [name, value] of entries) {
      const [first, ...rest] = name.split('/');
      if (!children.has(first)) children.set(first, []);
      children.get(first).push([rest.join('/'), value]);
    }
    const rows = [...children].map(([name, values]) => {
      if (values[0][0]) return `040000 tree ${tree(values)}\t${name}\0`;
      const value = values[0][1];
      const content = typeof value === 'object' ? value.content : value;
      return `${typeof value === 'object' ? value.mode : '100644'} blob ${git(repository, ['hash-object', '-w', '--stdin'], content)}\t${name}\0`;
    }).join('');
    return git(repository, ['mktree', '-z'], rows);
  }
  const rootTree = tree(Object.entries(all).map(([name, value]) => [`plugins/astra-project-forge/${name}`, value]));
  const candidate = git(repository, ['commit-tree', rootTree], 'Synthetic fixture only\n');
  const evidenceDirectory = path.join(temporary, 'evidence');
  const calls = [];
  function execute(command, args, options) {
    if (command !== 'npm') return spawnSync(command, args, { ...options, stdio: 'pipe' });
    calls.push({ args, cwd: options.cwd, env: options.env });
    return { status: 0, stdout: Buffer.from(`fixture stdout ${args.join(' ')}\n`), stderr: Buffer.from('fixture stderr\n') };
  }
  return { temporary, repository, candidate, evidenceDirectory, calls, execute, all };
}

function receipt(f) { return JSON.parse(readFileSync(path.join(f.evidenceDirectory, 'receipt.json'), 'utf8')); }
function assertClean(f, result) {
  assert.equal(existsSync(result.scratchDirectory), false, 'owned scratch must be removed');
  assert.equal(receipt(f).cleanup, 'removed');
  assert.ok(existsSync(f.repository), 'caller repository must survive');
}

test('fresh-source orchestration with cheap command and stdio fixtures', async t => {
  assert.ok(existsSync(moduleURL), 'portability orchestration implementation is required');
  const { verifyPortability } = await import(moduleURL.href);

  await t.test('exact committed manifest, legal hashes, metadata, unmodified gates and isolated discovery', async t => {
    const f = fixture(t);
    const result = await verifyPortability(f);
    assert.equal(result.exitCode, 0, JSON.stringify(receipt(f)));
    const r = receipt(f);
    assert.equal(r.candidate, f.candidate);
    assert.deepEqual(r.metadata, { node: process.version, platform: process.platform, arch: process.arch });
    assert.deepEqual(r.legalHashes, { 'LICENSE': hash(files.LICENSE), 'NOTICE.md': hash(files['NOTICE.md']), 'ATTRIBUTION.md': hash(files['ATTRIBUTION.md']) });
    const before = JSON.parse(readFileSync(path.join(f.evidenceDirectory, 'manifest.before.json')));
    assert.deepEqual(before.map(entry => entry.path).sort(), Object.keys(files).sort());
    assert.equal(before.find(entry => entry.path === 'nested/source.txt').sha256, hash(files['nested/source.txt']));
    assert.deepEqual(JSON.parse(readFileSync(path.join(f.evidenceDirectory, 'manifest.after.json'))), before);
    assert.equal(r.manifestSha256, hash(readFileSync(path.join(f.evidenceDirectory, 'manifest.before.json'))));
    assert.deepEqual(f.calls.map(c => c.args), [['run', 'check'], ['test'], ['run', 'benchmark:efficiency'], ['run', 'benchmark:routing:self-test']]);
    assert.ok(f.calls.every(c => c.cwd === result.sourceDirectory && c.env.HOME.startsWith(result.scratchDirectory)));
    assert.ok(f.calls.every(c => c.env.ASTRA_FORGE_MODEL_ROUTING === 'off' && c.env.ASTRA_REQUIRED_MODEL === undefined && c.env.ASTRA_ALLOWED_MODELS === undefined));
    assert.equal(r.commands.filter(c => c.command === 'npm').length, 4);
    for (const c of r.commands) {
      assert.deepEqual(c.closeErrors, []);
      assert.ok(existsSync(path.join(f.evidenceDirectory, c.stdout)));
      assert.ok(existsSync(path.join(f.evidenceDirectory, c.stderr)));
      assert.equal(readFileSync(path.join(f.evidenceDirectory, c.exitFile), 'utf8'), `${c.exitCode}\n`);
    }
    assert.deepEqual(r.discovery.map(d => [d.mode, d.policy]), [['off', 'default'], ['advisory-v1', 'default'], ['off', 'dual'], ['advisory-v1', 'dual']]);
    for (const d of r.discovery) {
      assert.deepEqual(d.tools.sort(), [...names].sort());
      assert.notEqual(d.cwd, result.sourceDirectory);
      assert.equal(path.isAbsolute(d.entrypoint), true);
      assert.equal(d.entrypoint, path.join(result.sourceDirectory, 'server/mcp-server.mjs'));
    }
    assert.equal(r.telemetry, null);
    assertClean(f, result);
  });

  await t.test('inner failure retains real exit and both streams then continues all gates and discovery', async t => {
    const f = fixture(t);
    const execute = (command, args, options) => command === 'npm' && args[0] === 'test'
      ? { status: 23, stdout: Buffer.from('full failed stdout\n'.repeat(200)), stderr: Buffer.from('full failed stderr\n'.repeat(200)) }
      : f.execute(command, args, options);
    const result = await verifyPortability({ ...f, execute });
    assert.equal(result.exitCode, 23);
    const r = receipt(f);
    assert.equal(r.commands.filter(c => c.command === 'npm').length, 4);
    assert.equal(r.discovery.length, 4);
    const failed = r.commands.find(c => c.command === 'npm' && c.args[0] === 'test');
    assert.equal(failed.exitCode, 23);
    assert.equal(readFileSync(path.join(f.evidenceDirectory, failed.stdout), 'utf8'), 'full failed stdout\n'.repeat(200));
    assert.equal(readFileSync(path.join(f.evidenceDirectory, failed.stderr), 'utf8'), 'full failed stderr\n'.repeat(200));
    assertClean(f, result);
  });

  await t.test('changed source bytes fail the before-execution comparison', async t => {
    const f = fixture(t);
    const execute = (command, args, options) => {
      const response = f.execute(command, args, options);
      if (command === 'git' && args.includes('cat-file') && response.stdout?.toString() === files['nested/source.txt']) response.stdout = Buffer.from('corrupted source\n');
      return response;
    };
    const result = await verifyPortability({ ...f, execute });
    assert.notEqual(result.exitCode, 0);
    assert.match(receipt(f).errors.join('\n'), /committed|manifest|hash/i);
    assert.equal(f.calls.length, 0);
    assertClean(f, result);
  });

  await t.test('post-execution mutations and added hidden files fail with both manifests retained', async t => {
    for (const target of ['nested/source.txt', '.hidden']) {
      const f = fixture(t);
      const execute = (command, args, options) => {
        if (command === 'npm' && args[0] === 'test') writeFileSync(path.join(options.cwd, target), 'changed');
        return f.execute(command, args, options);
      };
      const result = await verifyPortability({ ...f, execute });
      assert.notEqual(result.exitCode, 0);
      assert.match(receipt(f).errors.join('\n'), /manifest|source/i);
      assert.ok(existsSync(path.join(f.evidenceDirectory, 'manifest.after.json')));
      assertClean(f, result);
    }
  });

  await t.test('unsafe links and forbidden Git/SDD source entries are rejected before any execution', async t => {
    for (const extra of [{ link: { mode: '120000', content: '/etc/passwd' } }, { '.superpowers/private': 'forbidden' }]) {
      const f = fixture(t, extra);
      const result = await verifyPortability(f);
      assert.notEqual(result.exitCode, 0);
      assert.match(receipt(f).errors.join('\n'), /unsafe|forbidden|regular/i);
      assert.equal(f.calls.length, 0);
      assertClean(f, result);
    }
  });

  await t.test('invalid metadata or incomplete discovery cannot produce a passing receipt', async t => {
    for (const extra of [
      { 'LICENSE': files.LICENSE + 'changed legal bytes' },
      { 'package.json': JSON.stringify({ name: 'fixture', version: '0', license: 'MIT', scripts: {} }) },
      { 'server/mcp-server.mjs': transport.replace('"forge_route",', '') },
      { 'server/mcp-server.mjs': "console.error('transport failed'); process.exit(17);" },
    ]) {
      const f = fixture(t, extra);
      const result = await verifyPortability(f);
      assert.notEqual(result.exitCode, 0);
      assert.ok(receipt(f).errors.length > 0);
      assertClean(f, result);
    }
  });

  await t.test('extraction command failure retains error, logs, status and cleanup', async t => {
    const f = fixture(t);
    const execute = (command, args, options) => args.includes('ls-tree')
      ? { status: 19, stdout: Buffer.from('partial tree'), stderr: Buffer.from('git fixture failure') }
      : f.execute(command, args, options);
    const result = await verifyPortability({ ...f, execute });
    assert.equal(result.exitCode, 19);
    assert.equal(receipt(f).commands.at(-1).exitCode, 19);
    assertClean(f, result);
  });

  await t.test('command exceptions fail closed while independent gates still run', async t => {
    const f = fixture(t);
    const execute = (command, args, options) => {
      if (command === 'npm' && args[0] === 'test') throw new Error('fixture spawn failure');
      return f.execute(command, args, options);
    };
    const result = await verifyPortability({ ...f, execute });
    assert.notEqual(result.exitCode, 0);
    const r = receipt(f);
    assert.equal(r.commands.filter(c => c.command === 'npm').length, 4);
    assert.equal(r.discovery.length, 4);
    assert.match(r.errors.join('\n'), /fixture spawn failure/);
    assertClean(f, result);
  });

  await t.test('unsafe source paths fail before blob extraction', async t => {
    const f = fixture(t);
    for (const [index, file] of ['../escape', '.git/config', '/absolute', 'nested/../../escape'].entries()) {
      const evidenceDirectory = path.join(f.temporary, `unsafe-${index}`);
      const execute = (command, args, options) => args.includes('ls-tree')
        ? { status: 0, stdout: Buffer.from(`100644 blob ${'a'.repeat(40)}\tplugins/astra-project-forge/${file}\0`), stderr: Buffer.alloc(0) }
        : f.execute(command, args, options);
      const result = await verifyPortability({ ...f, evidenceDirectory, execute });
      assert.notEqual(result.exitCode, 0);
      assert.match(receipt({ evidenceDirectory }).errors.join('\n'), /unsafe|forbidden/);
      assert.equal(receipt({ evidenceDirectory }).commands.some(c => c.args.includes('cat-file')), false);
      assertClean({ ...f, evidenceDirectory }, result);
    }
  });

  await t.test('CLI rejects invalid SHA without deleting or writing caller source', async t => {
    const f = fixture(t);
    const before = readdirSync(f.repository).sort();
    const result = spawnSync(process.execPath, [moduleURL.pathname], { encoding: 'utf8', cwd: f.repository,
      env: { PATH: process.env.PATH, CANDIDATE_SHA: 'main', RUNNER_TEMP: f.temporary } });
    assert.notEqual(result.status, 0);
    assert.ok(existsSync(f.repository));
    assert.deepEqual(readdirSync(f.repository).sort(), before);
  });

  await t.test('CLI streams complete command evidence through the real process boundary', async t => {
    const f = fixture(t);
    const bin = path.join(f.temporary, 'fixture-bin');
    mkdirSync(bin);
    const npm = path.join(bin, 'npm');
    writeFileSync(npm, `#!${process.execPath}\nconsole.log('synthetic npm fixture: ' + process.argv.slice(2).join(' '));
      console.error('synthetic stderr');
      if (process.argv[2] === 'test') process.stdout.write('x'.repeat(2 * 1024 * 1024));\n`);
    chmodSync(npm, 0o755);
    const result = spawnSync(process.execPath, [moduleURL.pathname], {
      cwd: f.repository, encoding: 'utf8', timeout: 20_000,
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, RUNNER_TEMP: f.temporary,
        CANDIDATE_SHA: f.candidate, ASTRA_ALLOWED_MODELS: 'must-not-inherit', ASTRA_FORGE_MODEL_ROUTING: 'invalid-inherited' },
    });
    assert.ifError(result.error);
    const evidenceDirectory = path.join(f.temporary, 'forge-verification/portability');
    const r = receipt({ evidenceDirectory });
    assert.equal(result.status, 0, JSON.stringify(r));
    const gate = r.commands.find(c => c.command === 'npm' && c.args[0] === 'test');
    assert.equal(readFileSync(path.join(evidenceDirectory, gate.stdout), 'utf8'), 'synthetic npm fixture: test\n' + 'x'.repeat(2 * 1024 * 1024));
    assert.equal(readFileSync(path.join(evidenceDirectory, gate.stderr), 'utf8'), 'synthetic stderr\n');
    assertClean({ ...f, evidenceDirectory }, r);
  });
});

test('source-directory replacement cannot make the final manifest follow an outside symlink', async t => {
  const { verifyPortability } = await import(moduleURL.href);
  const f = fixture(t);
  const outside = path.join(f.temporary, 'outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'sentinel'), 'must never enter evidence');
  const execute = (command, args, options) => {
    if (command === 'npm' && args[0] === 'test') {
      renameSync(options.cwd, options.cwd + '-moved');
      symlinkSync(outside, options.cwd, 'dir');
    }
    return f.execute(command, args, options);
  };
  const result = await verifyPortability({ ...f, execute });
  assert.notEqual(result.exitCode, 0);
  assert.match(receipt(f).errors.join('\n'), /unsafe source directory/);
  assert.equal(readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'must never enter evidence');
  assertClean(f, result);
});

test('stream acquisition failures close acquired descriptors and retain independent command evidence', async t => {
  const { verifyPortability } = await import(moduleURL.href);
  for (const stream of ['stderr', 'stdout']) {
    await t.test(`${stream} open failure`, async t => {
      const f = fixture(t);
      const originalOpen = fs.openSync;
      let blocked, attemptedIndex;
      const acquired = [];
      const handle = t.mock.method(fs, 'openSync', (file, ...args) => {
        const fd = originalOpen(file, ...args);
        if (blocked && file === blocked.replace('.stderr.log', '.stdout.log')) acquired.push(fd);
        return fd;
      });
      syncBuiltinESMExports();
      let result;
      try {
        const execute = (command, args, options) => {
          if (command === 'npm' && args.join(' ') === 'run check') {
            // The current check command is not in the ledger yet. Block only
            // the next command's selected stream using a real EISDIR failure.
            attemptedIndex = JSON.parse(readFileSync(path.join(f.evidenceDirectory, 'commands.json'))).length + 1;
            blocked = path.join(f.evidenceDirectory, `commands/${String(attemptedIndex).padStart(4, '0')}.${stream}.log`);
            mkdirSync(blocked);
          }
          return f.execute(command, args, options);
        };
        result = await verifyPortability({ ...f, execute });
      } finally {
        handle.mock.restore();
        syncBuiltinESMExports();
      }
      const closed = acquired.map(fd => {
        try { fs.fstatSync(fd); return false; }
        catch (error) { assert.equal(error.code, 'EBADF'); return true; }
        finally {
          // RED can leak the descriptor: reclaim only the recorded fixture FD.
          try { fs.closeSync(fd); } catch (error) { assert.equal(error.code, 'EBADF'); }
        }
      });
      assert.equal(acquired.length, stream === 'stderr' ? 1 : 0);
      assert.deepEqual(closed, stream === 'stderr' ? [true] : [], 'every acquired descriptor must be closed');
      assert.notEqual(result.exitCode, 0);
      const r = receipt(f);
      const attempted = r.commands[attemptedIndex];
      assert.ok(attempted, 'attempted command must remain in the ledger after stream-open failure');
      assert.equal(attempted.command, 'npm');
      assert.deepEqual(attempted.args, ['test']);
      assert.equal(attempted.status, null);
      assert.equal(attempted.exitCode, 1);
      assert.match(attempted.error, /EISDIR/);
      assert.deepEqual(attempted.closeErrors, []);
      assert.equal(attempted.stderr, null, 'an unopened stream must not be advertised as retained');
      assert.equal(attempted.stdout, stream === 'stderr' ? `commands/${String(attemptedIndex).padStart(4, '0')}.stdout.log` : null);
      if (attempted.stdout !== null) assert.equal(fs.statSync(path.join(f.evidenceDirectory, attempted.stdout)).isFile(), true);
      assert.equal(readFileSync(path.join(f.evidenceDirectory, attempted.exitFile), 'utf8'), '1\n');
      assert.deepEqual(JSON.parse(readFileSync(path.join(f.evidenceDirectory, 'commands.json'))), r.commands);
      assert.deepEqual(r.commands.filter(c => c.command === 'npm').map(c => c.args),
        [['run', 'check'], ['test'], ['run', 'benchmark:efficiency'], ['run', 'benchmark:routing:self-test']]);
      assert.deepEqual(f.calls.map(c => c.args), [['run', 'check'], ['run', 'benchmark:efficiency'], ['run', 'benchmark:routing:self-test']]);
      assert.equal(r.discovery.length, 4);
      assert.ok(r.discovery.every(d => d.verified));
      assertClean(f, result);
    });
  }
});

test('stream close failures attempt all acquired descriptors without masking primary errors', async t => {
  const { verifyPortability } = await import(moduleURL.href);
  for (const primaryFailure of [false, true]) {
    await t.test(primaryFailure ? 'primary execute failure plus both close errors' : 'first close error after successful execute', async t => {
      const f = fixture(t);
      let descriptors;
      const execute = (command, args, options) => {
        if (command === 'npm' && args[0] === 'test') {
          descriptors = options.stdio.slice(1);
          // Actual EBADF on the runner's later close; stderr still needs a close
          // attempt even if stdout close fails. No production fault switches.
          fs.closeSync(descriptors[0]);
          if (primaryFailure) {
            fs.closeSync(descriptors[1]);
            throw new Error('primary execute failure');
          }
        }
        return f.execute(command, args, options);
      };
      const result = await verifyPortability({ ...f, execute });
      const closed = descriptors.map(fd => {
        try { fs.fstatSync(fd); return false; }
        catch (error) { assert.equal(error.code, 'EBADF'); return true; }
        finally { try { fs.closeSync(fd); } catch (error) { assert.equal(error.code, 'EBADF'); } }
      });
      assert.deepEqual(closed, [true, true], 'stdout close failure must not prevent stderr cleanup');
      const r = receipt(f);
      const attempted = r.commands.find(c => c.command === 'npm' && c.args[0] === 'test');
      assert.ok(attempted, 'close failure must not bypass the command ledger');
      assert.equal(attempted.exitCode, 1);
      assert.equal(attempted.status, primaryFailure ? null : 0);
      if (primaryFailure) assert.equal(attempted.error, 'primary execute failure');
      else assert.match(attempted.error, /EBADF/);
      assert.deepEqual(attempted.closeErrors.map(e => e.stream), primaryFailure ? ['stdout', 'stderr'] : ['stdout']);
      assert.ok(attempted.closeErrors.every(e => /EBADF/.test(e.message)));
      assert.equal(readFileSync(path.join(f.evidenceDirectory, attempted.exitFile), 'utf8'), '1\n');
      assert.deepEqual(JSON.parse(readFileSync(path.join(f.evidenceDirectory, 'commands.json'))), r.commands);
      assert.equal(r.commands.filter(c => c.command === 'npm').length, 4);
      assert.equal(r.discovery.length, 4);
      assert.ok(r.discovery.every(d => d.verified));
      assert.equal(result.exitCode, 1);
      assertClean(f, result);
    });
  }
});

test('unwritable evidence fails closed and still removes owned scratch', async t => {
  const { verifyPortability } = await import(moduleURL.href);
  const f = fixture(t);
  let scratchDirectory;
  const execute = (command, args, options) => {
    if (command === 'npm' && args.join(' ') === 'run check') {
      scratchDirectory = path.dirname(options.cwd);
      mkdirSync(path.join(f.evidenceDirectory, 'receipt.json'));
    }
    return f.execute(command, args, options);
  };
  await assert.rejects(verifyPortability({ ...f, execute }), { code: 'EISDIR' });
  assert.equal(existsSync(scratchDirectory), false);
  assert.equal(fs.statSync(path.join(f.evidenceDirectory, 'receipt.json')).isDirectory(), true);
  assert.ok(existsSync(f.repository));
});
