import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, link, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const archiveNames = ['astra-project-forge-local-2.6.1.zip', 'astra-project-forge-local-marketplace-2.6.1.zip'];
const requiredFiles = [
  '.codex-plugin/plugin.json', '.mcp.json', 'package.json', 'README.md',
  'LICENSE', 'NOTICE.md', 'ATTRIBUTION.md', 'hooks/hooks.json', 'hooks/astra-model-gate.mjs',
  'assets/icon.png', 'assets/logo.png', 'server/mcp-server.mjs',
  'skills/astra-project-forge/SKILL.md', 'docs/INSTALL.md', 'docs/TOOLS.md',
  'docs/DESIGN-v2.6.1.md', 'scripts/benchmark-v261.mjs', 'scripts/package-release.mjs',
  'tests/v261-release-package.test.mjs', 'tests/fixtures/v260-baseline/README.md',
  'tests/fixtures/v260-baseline/server/mcp-server.mjs'
];
const expectedManifest = {
  name: 'astra-project-forge-personal',
  interface: { displayName: 'Astra Project Forge Personal' },
  plugins: [{ name: 'astra-project-forge', source: { source: 'local', path: './plugins/astra-project-forge' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }]
};

function run(command, args, cwd = tmpdir()) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

async function build(source, output) {
  const helper = path.join(source, 'scripts/package-release.mjs');
  assert.ok((await readdir(path.join(source, 'scripts'))).includes('package-release.mjs'),
    'release needs a package-local build helper');
  return JSON.parse(run(process.execPath, [helper, '--output-dir', output]));
}

async function copyPlugin(destination) {
  // Parallel integration tests create and remove .task-* scratch directories in the root.
  await cp(root, destination, {
    recursive: true,
    filter: source => !path.relative(root, source).startsWith('.task-')
  });
}

async function files(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await files(path.join(directory, entry.name), relative));
    else result.push(relative);
  }
  return result.sort();
}

for (const [target, suffix] of [['', ''], ['docs', ''], ['docs', 'missing/nested']]) {
  test(`release rejects external source symlink target=${target || '.'} suffix=${suffix || '.'}`, async () => {
    const temp = await mkdtemp(path.join(tmpdir(), 'astra release alias '));
    try {
      const source = path.join(temp, 'plugin');
      await copyPlugin(source);
      const before = await files(source);
      const alias = path.join(temp, 'external-alias');
      await symlink(path.join(source, target), alias, 'dir');
      const result = spawnSync(process.execPath, [path.join(source, 'scripts/package-release.mjs'),
        '--output-dir', path.join(alias, suffix)], { encoding: 'utf8', timeout: 30000 });
      assert.ifError(result.error);
      assert.equal(result.status, 1, 'source alias must be rejected');
      assert.match(result.stderr, /Archive output must be outside the plugin source directory/);
      assert.deepEqual(await files(source), before, 'rejection must not write into source');
      if (suffix) assert.equal((await readdir(path.join(source, target))).includes('missing'), false);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
}

test('second ZIP build failure preserves both archives and cleans staging', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'astra release failure '));
  try {
    const output = path.join(temp, 'archives');
    const scratch = path.join(temp, 'scratch');
    await mkdir(output);
    await mkdir(scratch);
    const previous = archiveNames.map(name => Buffer.from(`previous ${name}`));
    for (let index = 0; index < archiveNames.length; index++) {
      await writeFile(path.join(output, archiveNames[index]), previous[index]);
    }
    const trace = path.join(temp, 'zip-calls.json');
    const preload = path.join(temp, 'fail-second-zip.mjs');
    // Inject only the external ZIP failure; the first ZIP and CLI filesystem work stay real.
    await writeFile(preload, `
import childProcess from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original = childProcess.spawnSync;
const archives = [];
childProcess.spawnSync = function(command, args, options) {
  if (command === 'zip') {
    archives.push(args[2]);
    writeFileSync(process.env.ZIP_TRACE, JSON.stringify(archives));
    if (archives.length === 2) {
      writeFileSync(args[2], 'partial second ZIP');
      return { status: 1, stdout: '', stderr: 'injected second ZIP failure' };
    }
  }
  return original(command, args, options);
};
syncBuiltinESMExports();
`);
    const result = spawnSync(process.execPath, ['--import', preload,
      path.join(root, 'scripts/package-release.mjs'), '--output-dir', output], {
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch, ZIP_TRACE: trace }
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /zip failed: injected second ZIP failure/);
    for (let index = 0; index < archiveNames.length; index++) {
      assert.ok((await readFile(path.join(output, archiveNames[index]))).equals(previous[index]),
        `failed second build must preserve ${archiveNames[index]}`);
    }
    assert.deepEqual((await readdir(output)).sort(), [...archiveNames].sort(), 'no destination staging remains');
    assert.deepEqual(await readdir(scratch), [], 'no source staging remains');
    const staged = JSON.parse(await readFile(trace, 'utf8'));
    assert.equal(staged.length, 2);
    for (const archive of staged) {
      const relative = path.relative(output, archive);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative),
        'ZIPs must be staged in the destination filesystem');
      assert.ok(!archiveNames.includes(relative), 'ZIPs must not be built at final paths');
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('release archives are complete, clean, repeatable and rebuild without checkout metadata', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'astra release +% '));
  try {
    const source = path.join(temp, 'isolated plugin');
    await copyPlugin(source);
    for (const junk of ['.git/config', '.superpowers/session', '.astra-project-forge/state.json',
      'scratch/debug.txt', 'server/scratch/debug.mjs', 'tests/.astra-project-forge/state.json',
      'node_modules/unwanted/index.js', 'docs/debug.log', 'old.zip']) {
      await mkdir(path.dirname(path.join(source, junk)), { recursive: true });
      await writeFile(path.join(source, junk), 'must not ship');
    }
    const output = path.join(temp, 'archives');
    const report = await build(source, output);
    assert.deepEqual(report.archives.map(item => path.basename(item.archive)), archiveNames);
    const original = await Promise.all(archiveNames.map(name => readFile(path.join(output, name))));
    // Rebuilding must replace archives, including stale entries in an old ZIP.
    run('zip', ['-q', path.join(output, archiveNames[0]), 'old.zip'], source);
    const oldArchive = path.join(temp, 'old-standalone.zip');
    await link(path.join(output, archiveNames[0]), oldArchive);
    const oldBytes = await readFile(oldArchive);
    await build(source, output);
    assert.ok((await readFile(oldArchive)).equals(oldBytes), 'replacement must not overwrite the old inode');
    assert.deepEqual((await readdir(output)).sort(), [...archiveNames].sort(), 'successful build cleans staging');
    for (let index = 0; index < archiveNames.length; index++) {
      const name = archiveNames[index];
      assert.deepEqual(await readFile(path.join(output, name)), original[index], 'repeatable archive bytes');
      const extraction = path.join(temp, `extract-${index}`);
      run('unzip', ['-q', path.join(output, name), '-d', extraction]);
      const top = index === 0 ? 'astra-project-forge-2.6.1' : 'astra-project-forge-local-marketplace-2.6.1';
      assert.deepEqual(await readdir(extraction), [top]);
      const plugin = index === 0 ? path.join(extraction, top) : path.join(extraction, top, 'plugins/astra-project-forge');
      const contents = await files(plugin);
      for (const required of requiredFiles) assert.ok(contents.includes(required), `missing ${required}`);
      assert.equal(contents.some(file => /(?:^|\/)(?:\.git|\.superpowers|\.astra-project-forge|scratch|node_modules)(?:\/|$)|\.(?:log|zip)$/.test(file)), false);
      for (const file of contents) {
        if (file === 'scripts/marketplace.json') continue;
        assert.deepEqual(await readFile(path.join(plugin, file)), await readFile(path.join(root, file)), `preserve ${file}`);
      }
      for (const legal of ['LICENSE', 'NOTICE.md', 'ATTRIBUTION.md']) {
        const sha = createHash('sha256').update(await readFile(path.join(plugin, legal))).digest('hex');
        const frozenSha = createHash('sha256').update(await readFile(path.join(root, 'tests/fixtures/v260-baseline', legal))).digest('hex');
        assert.equal(sha, frozenSha, `immutable ${legal}`);
      }
      if (index === 1) {
        const manifest = JSON.parse(await readFile(path.join(extraction, top, '.agents/plugins/marketplace.json'), 'utf8'));
        assert.deepEqual(manifest, expectedManifest);
      }
      assert.deepEqual(JSON.parse(await readFile(path.join(plugin, 'scripts/marketplace.json'), 'utf8')), expectedManifest);
      run(process.execPath, ['--test', path.join(plugin, 'tests/mcp-startup.test.mjs')]);
      const rebuilt = path.join(temp, `rebuilt-${index}`);
      await build(plugin, rebuilt);
      for (let other = 0; other < archiveNames.length; other++) {
        assert.deepEqual(await readFile(path.join(rebuilt, archiveNames[other])), original[other], 'standalone rebuild');
      }
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
