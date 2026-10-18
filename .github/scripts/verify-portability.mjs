import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const prefix = 'plugins/astra-project-forge/';
const legalHashes = {
  'LICENSE': '5132c7f0475b02c8107a2e0f0363e70423c62d2664ab927e76193226e5e05905',
  'NOTICE.md': 'c35cd5c397efd7eb5313a46f8bce86065f92745d1e080fba134e537e4bcfe598',
  'ATTRIBUTION.md': '74a9857795d90cd3368a73331192f712cc9412d95314eee18ce95486781501a4',
};
const toolNames = ['forge_route', 'forge_goal', 'forge_context', 'forge_observe', 'forge_plan',
  'forge_evaluate', 'forge_adapt', 'forge_checkpoint', 'forge_consolidate', 'adaptive_route_task',
  'adaptive_get_context', 'adaptive_initialize_project', 'adaptive_get_state', 'adaptive_list_projects',
  'adaptive_record_observation', 'adaptive_record_hypothesis', 'adaptive_record_experiment',
  'adaptive_checkpoint', 'adaptive_consolidate'];
const gates = [['run', 'check'], ['test'], ['run', 'benchmark:efficiency'], ['run', 'benchmark:routing:self-test']];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sortManifest = entries => entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);

function snapshot(directory, relative = '') {
  assert.ok(lstatSync(path.join(directory, relative)).isDirectory(), 'unsafe source directory');
  const entries = [];
  for (const name of readdirSync(path.join(directory, relative))) {
    const file = path.posix.join(relative, name);
    const absolute = path.join(directory, file);
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) entries.push(...snapshot(directory, file));
    else if (stat.isFile()) entries.push({ path: file, mode: stat.mode & 0o111 ? '100755' : '100644', sha256: digest(readFileSync(absolute)) });
    else entries.push({ path: file, unsafe: true });
  }
  return sortManifest(entries);
}

// The injected command boundary is used only by cheap root fixtures. CLI always
// executes the real commands and streams their complete output directly to disk.
export async function verifyPortability({ repository, candidate, evidenceDirectory, execute = spawnSync }) {
  assert.match(candidate, /^[0-9a-f]{40}$/, 'candidate must be full lowercase 40-hex');
  repository = realpathSync(repository);
  evidenceDirectory = path.resolve(evidenceDirectory);
  assert.ok(!inside(repository, evidenceDirectory), 'evidence must be outside the checkout');
  mkdirSync(evidenceDirectory, { recursive: true });
  assert.equal(readdirSync(evidenceDirectory).length, 0, 'evidence directory must be empty');
  const save = (name, value) => writeFileSync(path.join(evidenceDirectory, name), JSON.stringify(value, null, 2) + '\n');
  const receipt = { candidate, metadata: { node: process.version, platform: process.platform, arch: process.arch },
    commands: [], discovery: [], errors: [], telemetry: null, cleanup: 'not_created' };
  let scratchDirectory, sourceDirectory, before, exitCode = 0;
  const fail = (error, code = 1) => {
    receipt.errors.push(error.message || String(error));
    if (exitCode === 0) exitCode = code;
  };
  function command(command, args, cwd, env, input, timeout) {
    const stem = `commands/${String(receipt.commands.length).padStart(4, '0')}`;
    const stdoutPath = `${stem}.stdout.log`, stderrPath = `${stem}.stderr.log`, exitFile = `${stem}.exit-code`;
    let out, err, stdout = null, stderr = null, result = { status: null };
    const closeErrors = [];
    try {
      out = openSync(path.join(evidenceDirectory, stdoutPath), 'w');
      stdout = stdoutPath;
      err = openSync(path.join(evidenceDirectory, stderrPath), 'w');
      stderr = stderrPath;
      if (command !== 'git') assert.ok(lstatSync(sourceDirectory).isDirectory(), 'unsafe source directory');
      result = execute(command, args, { cwd, env, input, timeout, stdio: ['pipe', out, err] });
      if (result.stdout != null) writeFileSync(path.join(evidenceDirectory, stdout), result.stdout);
      if (result.stderr != null) writeFileSync(path.join(evidenceDirectory, stderr), result.stderr);
    } catch (error) {
      result = { ...result, error };
    } finally {
      for (const [fd, stream] of [[out, 'stdout'], [err, 'stderr']]) {
        if (fd === undefined) continue;
        try { closeSync(fd); }
        catch (error) { closeErrors.push({ stream, message: error.message || String(error) }); }
      }
    }
    const code = result.status === 0 && !result.error && !result.signal && closeErrors.length === 0 ? 0 : result.status || 1;
    const entry = { command, args, cwd, exitCode: code, status: result.status ?? null,
      signal: result.signal ?? null, error: result.error?.message ?? closeErrors[0]?.message ?? null,
      closeErrors, stdout, stderr, exitFile };
    receipt.commands.push(entry);
    writeFileSync(path.join(evidenceDirectory, exitFile), `${code}\n`);
    save('commands.json', receipt.commands);
    if (code !== 0) fail(new Error(`${command} ${args.join(' ')} failed (${code})${entry.error ? `: ${entry.error}` : ''}${closeErrors.map(e => `; ${e.stream} close: ${e.message}`).join('')}`), code);
    return { ...entry, bytes: () => readFileSync(path.join(evidenceDirectory, stdout)) };
  }
  try {
    const temporary = realpathSync(tmpdir());
    assert.ok(!inside(repository, temporary), 'scratch must be outside the checkout');
    scratchDirectory = mkdtempSync(path.join(temporary, 'forge-portability-'));
    sourceDirectory = path.join(scratchDirectory, 'fresh plugin +% source');
    const unrelated = path.join(scratchDirectory, 'unrelated-cwd');
    const home = path.join(scratchDirectory, 'home');
    const temp = path.join(scratchDirectory, 'tmp');
    for (const directory of [sourceDirectory, unrelated, home, temp, path.join(evidenceDirectory, 'commands')]) mkdirSync(directory);
    receipt.scratchDirectory = scratchDirectory;
    receipt.sourceDirectory = sourceDirectory;
    const env = { PATH: process.env.PATH, HOME: home, TMPDIR: temp, TEMP: temp, TMP: temp,
      XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, npm_config_cache: path.join(scratchDirectory, 'npm-cache'),
      npm_config_userconfig: path.join(home, '.npmrc'), npm_config_globalconfig: path.join(home, 'global.npmrc'),
      npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false',
      ASTRA_PROJECT_FORGE_DATA_DIR: path.join(scratchDirectory, 'gate-data'), ASTRA_FORGE_MODEL_ROUTING: 'off',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' };
    const git = args => command('git', ['--no-replace-objects', '-C', repository, ...args], repository, env);
    const required = result => { assert.equal(result.exitCode, 0, 'source extraction command failed'); return result.bytes(); };
    assert.equal(required(git(['rev-parse', '--verify', `${candidate}^{commit}`])).toString().trim(), candidate);
    const tree = required(git(['ls-tree', '-rz', '--full-tree', candidate, '--', prefix]));
    assert.ok(Buffer.from(tree.toString('utf8'), 'utf8').equals(tree), 'unsafe non-UTF-8 source path');
    const records = tree.toString('utf8').split('\0');
    assert.equal(records.pop(), '', 'unterminated Git source tree');
    assert.ok(records.length > 0, 'committed plugin tree is empty');
    const seen = new Set();
    const committed = [];
    // Validate the entire tree before writing any entry; Git blobs avoid tar
    // traversal, symlink dereferencing, checkout filters, and installed files.
    const entries = records.map(record => {
      const match = /^(100644|100755) blob ([0-9a-f]{40})\t([\s\S]+)$/.exec(record);
      assert.ok(match, 'unsafe source entry: only regular Git blobs are allowed');
      const [, mode, oid, fullPath] = match;
      assert.ok(fullPath.startsWith(prefix), 'unsafe source prefix');
      const file = fullPath.slice(prefix.length);
      assert.ok(file && !file.includes('\\') && !/[\x00-\x1f\x7f]/.test(file), 'unsafe source path');
      assert.ok(file.split('/').every(part => part && !['.', '..', '.git', '.superpowers'].includes(part.toLowerCase())), 'forbidden source path');
      assert.ok(!path.isAbsolute(file) && !seen.has(file), 'unsafe or duplicate source path');
      seen.add(file);
      return { file, mode, oid };
    });
    save('committed-tree.json', entries);
    for (const { file, mode, oid } of entries) {
      const bytes = required(git(['cat-file', 'blob', oid]));
      const actualOid = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      assert.equal(actualOid, oid, `committed blob hash mismatch: ${file}`);
      const absolute = path.join(sourceDirectory, file);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, bytes, { flag: 'wx' });
      chmodSync(absolute, mode === '100755' ? 0o755 : 0o644);
      committed.push({ path: file, mode, sha256: digest(bytes) });
    }
    save('manifest.committed.json', sortManifest(committed));
    before = snapshot(sourceDirectory);
    save('manifest.before.json', before);
    assert.deepEqual(before, committed, 'extracted manifest differs from exact committed source');
    receipt.manifestSha256 = digest(readFileSync(path.join(evidenceDirectory, 'manifest.before.json')));
    receipt.legalHashes = Object.fromEntries(Object.keys(legalHashes).map(file => [file, digest(readFileSync(path.join(sourceDirectory, file)))]));
    assert.deepEqual(receipt.legalHashes, legalHashes, 'original legal-file hashes changed');
    const pkg = JSON.parse(readFileSync(path.join(sourceDirectory, 'package.json'), 'utf8'));
    assert.equal(pkg.license, 'AGPL-3.0-only', 'package legal metadata must be preserved');
    assert.ok(typeof pkg.version === 'string' && pkg.version.length > 0, 'package version metadata missing');
    for (const key of ['check', 'test', 'benchmark:efficiency', 'benchmark:routing:self-test']) assert.ok(typeof pkg.scripts?.[key] === 'string' && pkg.scripts[key], `missing unmodified package script: ${key}`);
    receipt.package = { name: pkg.name, version: pkg.version, license: pkg.license };
    for (const args of gates) command('npm', args, sourceDirectory, env);
    const input = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'native-portability', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ].map(value => JSON.stringify(value)).join('\n') + '\n';
    save('discovery.requests.json', input.trim().split('\n').map(line => JSON.parse(line)));
    for (const policy of ['default', 'dual']) {
      for (const mode of ['off', 'advisory-v1']) {
        const entrypoint = path.join(sourceDirectory, 'server/mcp-server.mjs');
        const discoveryEnv = { ...env, ASTRA_FORGE_MODEL_ROUTING: mode,
          ASTRA_PROJECT_FORGE_DATA_DIR: path.join(scratchDirectory, `data-${policy}-${mode}`),
          ...(policy === 'dual' ? { ASTRA_REQUIRED_MODEL: 'gpt-6-astra', ASTRA_ALLOWED_MODELS: 'gpt-6-astra,gpt-6.1-sol' } : {}) };
        const result = command(process.execPath, [entrypoint, '--stdio'], unrelated, discoveryEnv, input, 10_000);
        const discovery = { policy, mode, cwd: unrelated, entrypoint, dataDirectory: discoveryEnv.ASTRA_PROJECT_FORGE_DATA_DIR,
          eligibility: policy === 'dual' ? { requiredModel: discoveryEnv.ASTRA_REQUIRED_MODEL, allowedModels: discoveryEnv.ASTRA_ALLOWED_MODELS } : null,
          commandIndex: receipt.commands.length - 1 };
        receipt.discovery.push(discovery);
        try {
          assert.equal(result.exitCode, 0, 'MCP process failed');
          const replies = result.bytes().toString('utf8').trim().split('\n').map(line => JSON.parse(line));
          assert.deepEqual(replies.map(r => r.id), [1, 2], 'MCP initialization/discovery replies missing or duplicated');
          for (const reply of replies) { assert.equal(reply.jsonrpc, '2.0'); assert.equal(reply.error, undefined); }
          const init = replies[0].result;
          assert.equal(init.serverInfo.name, 'astra-project-forge');
          assert.equal(init.serverInfo.version, pkg.version);
          assert.equal(init.protocolVersion, '2025-06-18');
          assert.equal(init.capabilities.tools.listChanged, false);
          const advice = init.capabilities.experimental?.modelRouting;
          if (mode === 'off') assert.equal(advice, undefined);
          else assert.deepEqual(advice, { version: 1, mode: 'advisory-v1' });
          const tools = replies[1].result.tools;
          discovery.tools = tools.map(tool => tool.name);
          assert.deepEqual([...discovery.tools].sort(), [...toolNames].sort(), 'all 19 tools must remain discoverable');
          const route = tools.find(tool => tool.name === 'forge_route');
          assert.equal(Object.hasOwn(route.inputSchema.properties, 'modelRouting'), mode === 'advisory-v1');
          discovery.verified = true;
        } catch (error) { discovery.verified = false; fail(error); }
      }
    }
  } catch (error) {
    fail(error);
  } finally {
    if (before) {
      try {
        const after = snapshot(sourceDirectory);
        save('manifest.after.json', after);
        assert.deepEqual(after, before, 'extracted source manifest changed during execution');
        receipt.sourceUnchanged = true;
      } catch (error) { receipt.sourceUnchanged = false; fail(error); }
    }
    if (scratchDirectory) {
      try { rmSync(scratchDirectory, { recursive: true, force: true }); receipt.cleanup = 'removed'; }
      catch (error) { receipt.cleanup = 'failed'; fail(error); }
    }
    receipt.exitCode = exitCode;
    save('receipt.json', receipt);
  }
  return { exitCode, scratchDirectory, sourceDirectory };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    assert.ok(process.env.RUNNER_TEMP, 'RUNNER_TEMP is required');
    const result = await verifyPortability({ repository: process.cwd(), candidate: process.env.CANDIDATE_SHA,
      evidenceDirectory: path.join(process.env.RUNNER_TEMP, 'forge-verification/portability') });
    console.log(`Fresh-source verification exit=${result.exitCode}; evidence=${path.join(process.env.RUNNER_TEMP, 'forge-verification/portability')}`);
    process.exitCode = result.exitCode;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
