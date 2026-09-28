import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const guidePath = 'docs/COMPACT-RESPONSES.md';
const verifiedCommit = 'cd0edae9921c80784e11ce3bcaec57f29c224786';
const controls = ['forge_route', 'forge_plan', 'forge_observe', 'forge_evaluate'];
const legalFiles = ['LICENSE', 'NOTICE.md', 'ATTRIBUTION.md'];

async function guide() {
  assert.ok(existsSync(path.join(root, guidePath)), 'compact response API/recovery guide must exist');
  return readFile(path.join(root, guidePath), 'utf8');
}

function examples(text) {
  return [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
}

function run(command, args, cwd = tmpdir()) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
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

async function copyPlugin(destination, sourceRoot = root) {
  // Parallel integration tests create and remove .task-* scratch in the root.
  await cp(sourceRoot, destination, {
    recursive: true,
    filter: source => !path.relative(sourceRoot, source).startsWith('.task-')
  });
}

test('source copy excludes root scratch before traversal and preserves stable metadata', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'forge-copy-'));
  try {
    const source = path.join(temp, '.task-copy-source');
    const destination = path.join(temp, 'copied-plugin');
    const stable = {
      '.codex-plugin/plugin.json': await readFile(path.join(root, '.codex-plugin/plugin.json'), 'utf8'),
      '.mcp.json': await readFile(path.join(root, '.mcp.json'), 'utf8'),
      'package.json': await readFile(path.join(root, 'package.json'), 'utf8'),
      'server/stable.mjs': 'export const stable = true;\n',
      'docs/.task-kept.md': 'Nested names are not root scratch.\n',
      '.tasksettings': 'This hidden file does not have the excluded prefix.\n',
    };
    for (const [file, content] of Object.entries(stable)) {
      await mkdir(path.dirname(path.join(source, file)), { recursive: true });
      await writeFile(path.join(source, file), content);
    }
    const scratchName = '.task-7-test-overlap';
    const scratch = path.join(source, scratchName);
    await mkdir(path.join(scratch, 'traversal-trap'), { recursive: true });
    await writeFile(path.join(scratch, 'state.json'), '{}\n');
    // A destination file conflicts with the source directory if cp enters scratch.
    const trap = `${scratchName}/traversal-trap`;
    await mkdir(path.join(destination, scratchName), { recursive: true });
    await writeFile(path.join(destination, trap), 'untouched destination marker');
    await assert.doesNotReject(() => copyPlugin(destination, source),
      'root .task-* scratch must be excluded before traversing its contents');
    assert.deepEqual(await files(destination), [...Object.keys(stable), trap].sort());
    assert.equal(await readFile(path.join(destination, trap), 'utf8'), 'untouched destination marker');
    for (const [file, content] of Object.entries(stable)) {
      assert.equal(await readFile(path.join(destination, file), 'utf8'), content, file);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('README links the opt-in contract and identifies three benchmark modes', async () => {
  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /\]\(docs\/COMPACT-RESPONSES\.md\)/);
  for (const mode of ['v260_baseline', 'v261_verified', 'v261_compact']) assert.ok(readme.includes(mode));
  assert.match(readme, /unpublished/);
  assert.match(readme, /cd0edae/);
});

test('guide distinguishes optional control summary/full from context levels with valid examples', async () => {
  const text = await guide();
  assert.match(text, /omitted[\s\S]*?`full`[\s\S]*?complete/i);
  assert.match(text, /`relevant`[\s\S]*?invalid/i);
  assert.match(text, /before[\s\S]*?mutation/i);
  const calls = examples(text);
  assert.deepEqual(calls.filter(call => controls.includes(call.name) && call.arguments.resultLevel === 'summary')
    .map(call => call.name).sort(), [...controls].sort());
  assert.ok(calls.some(call => call.name === 'forge_route' && call.arguments.resultLevel === 'full'));
  assert.match(text, /19/);
  assert.match(text, /soft[ -]budget/i);
  assert.match(text, /justify-before-spend/);
  assert.match(text, /failed[ -]strateg/i);
  assert.match(text, /verified success/i);
});

test('guide lists exactly the implemented omissions and preserved response evidence', async () => {
  const text = await guide();
  const rows = [...text.matchAll(/^\| `(forge_\w+)` \| `(\w+)` \| ([^\n]+) \|$/gm)]
    .map(([, tool, record, fields]) => [tool, record, [...fields.matchAll(/`(\w+)`/g)].map(match => match[1])]);
  assert.deepEqual(rows, [
    ['forge_route', 'route', ['score', 'complexity', 'uncertainty', 'expectedIterations', 'contextDetail', 'cycleBudget']],
    ['forge_plan', 'plan', ['action', 'why', 'expectedEvidence', 'createdAt']],
    ['forge_observe', 'observation', ['observation', 'evidence', 'createdAt']],
    ['forge_observe', 'claim', ['createdAt', 'updatedAt']],
    ['forge_observe', 'transferCandidate', ['createdAt', 'updatedAt', 'relevance']],
    ['forge_observe', 'evidenceRecord', ['result']],
    ['forge_evaluate', 'evaluation', ['createdAt']],
  ]);
  for (const field of ['guidance', 'reasons', 'stateDetail', 'softCycleBudget']) assert.ok(text.includes(`\`${field}\``));
  assert.match(text, /null[\s\S]*?preserv/i);
  assert.match(text, /unknown[\s\S]*?preserv/i);
  assert.match(text, /retriev[\s\S]*?`evidenceRecord\.result`[\s\S]*?retain/i);
  assert.match(text, /error[\s\S]*?unchanged/i);
});

test('guide recovers complete persisted records read-only and explains projectless routing', async () => {
  const text = await guide();
  const calls = examples(text);
  const recovery = calls.find(call => call.name === 'forge_context');
  assert.deepEqual(recovery?.arguments, { projectId: 'example-project', detail: 'full', resultLevel: 'full' });
  assert.ok(calls.some(call => call.name === 'adaptive_get_state' && call.arguments.projectId === 'example-project'));
  for (const field of ['structuredContent.context.project', 'structuredContent.project', 'efficiency.lastRoute',
    'efficiency.evidenceCache', 'plans', 'observations', 'claims', 'transferCandidates', 'evaluations']) assert.ok(text.includes(`\`${field}\``));
  assert.match(text, /read-only/);
  assert.match(text, /omit `sinceRevision`/i);
  assert.match(text, /do not re-run[\s\S]*?mutation/i);
  assert.match(text, /latest[\s\S]*?not[\s\S]*?route history/i);
  assert.match(text, /without `projectId`[\s\S]*?not persisted/i);
  assert.match(text, /cannot[\s\S]*?recover[\s\S]*?context/i);
  assert.ok(calls.some(call => call.name === 'forge_route' && !Object.hasOwn(call.arguments, 'projectId')
    && call.arguments.resultLevel === 'full'));
});

test('guide documents immutable benchmark sources and request plus response limitations', async () => {
  const text = await guide();
  for (const value of ['v260_baseline', 'v261_verified', 'v261_compact', 'v261_efficiency', verifiedCommit,
    'tests/fixtures/v261-verified/provenance.json', 'npm run benchmark:efficiency',
    'JSON.stringify', 'coordinationRequestBytes', 'coordinationResponseBytes', 'coordinationCombinedBytes', 'contextBytes']) {
    assert.ok(text.includes(value), value);
  }
  assert.match(text, /unpublished/);
  assert.match(text, /commit[\s\S]*?content hash/i);
  assert.match(text, /transport[ -]envelope[\s\S]*?excluded/i);
  assert.match(text, /contextBytes[\s\S]*?subset[\s\S]*?not added/i);
  assert.match(text, /one run per workload\/mode/i);
  assert.match(text, /model turns[\s\S]*?tokens[\s\S]*?cache[\s\S]*?billing[\s\S]*?null/i);
  assert.match(text, /not[\s\S]*?speed[\s\S]*?guarantee/i);
});

test('skill scopes relevant to context and links the control API reference', async () => {
  const skill = await readFile(path.join(root, 'skills/astra-project-forge/SKILL.md'), 'utf8');
  assert.match(skill, /On `forge_context`, use `resultLevel` progressively: `summary`, `relevant`, then `full`/);
  assert.match(skill, /forge_route[\s\S]*?forge_plan[\s\S]*?forge_observe[\s\S]*?forge_evaluate[\s\S]*?`summary`[\s\S]*?`full`/);
  assert.match(skill, /\]\(\.\.\/\.\.\/docs\/COMPACT-RESPONSES\.md\)/);
});

test('both package layouts ship the compact contract and immutable dependencies without scratch/state', async t => {
  const temp = await mkdtemp(path.join(tmpdir(), 'forge-compact-package-'));
  try {
    const relative = path.relative(await realpath(root), await realpath(temp));
    assert.ok(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
    const source = path.join(temp, 'plugin');
    await copyPlugin(source);
    const junk = ['.git/config', '.superpowers/session', '.astra-project-forge/state.json',
      'tests/.ignored-scratch/state.json', 'tests/scratch/debug.txt', 'server/state/project.json',
      'docs/debug.log', 'docs/old.zip'];
    for (const file of junk) {
      await mkdir(path.dirname(path.join(source, file)), { recursive: true });
      await writeFile(path.join(source, file), 'must not ship');
    }
    const packaged = JSON.parse(run(process.execPath, [path.join(source, 'scripts/package-release.mjs'),
      '--output-dir', path.join(temp, 'archives')]));
    assert.equal(packaged.version, '2.6.1');
    assert.deepEqual(packaged.archives.map(item => item.pluginPath), [
      'astra-project-forge-2.6.1', 'astra-project-forge-local-marketplace-2.6.1/plugins/astra-project-forge',
    ]);
    for (const [index, archive] of packaged.archives.entries()) {
      await t.test(index === 0 ? 'standalone' : 'marketplace', async () => {
        const extraction = path.join(temp, `extract-${index}`);
        run('unzip', ['-q', archive.archive, '-d', extraction]);
        const plugin = path.join(extraction, archive.pluginPath);
        const contents = await files(plugin);
        for (const file of junk) assert.ok(!contents.includes(file), file);
        assert.equal(contents.some(file => /(?:^|\/)(?:\.git|\.superpowers|\.astra-project-forge|scratch|state|node_modules)(?:\/|$)|\.(?:log|zip)$/.test(file)), false);
        const fixtureFiles = await files(path.join(root, 'tests/fixtures/v261-verified'));
        for (const file of ['server/control-results.mjs', 'server/mcp-server.mjs', 'scripts/benchmark-v261.mjs',
          'scripts/package-release.mjs', 'package.json', '.codex-plugin/plugin.json', ...legalFiles,
          ...fixtureFiles.map(file => `tests/fixtures/v261-verified/${file}`)]) {
          assert.ok(contents.includes(file), `missing ${file}`);
          assert.deepEqual(await readFile(path.join(plugin, file)), await readFile(path.join(root, file)), file);
        }
        const provenance = JSON.parse(await readFile(path.join(plugin, 'tests/fixtures/v261-verified/provenance.json'), 'utf8'));
        assert.equal(provenance.commit, verifiedCommit);
        for (const [file, expected] of Object.entries(provenance.sha256)) {
          const bytes = await readFile(path.join(plugin, 'tests/fixtures/v261-verified', file));
          assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, file);
        }
        for (const file of legalFiles) {
          assert.deepEqual(await readFile(path.join(plugin, file)),
            await readFile(path.join(plugin, 'tests/fixtures/v261-verified', file)), file);
        }
        for (const file of [guidePath, 'README.md', 'skills/astra-project-forge/SKILL.md', 'tests/v261-compact-package.test.mjs']) {
          assert.ok(contents.includes(file), `missing follow-up documentation/contract: ${file}`);
          assert.deepEqual(await readFile(path.join(plugin, file)), await readFile(path.join(root, file)), file);
        }
      });
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
