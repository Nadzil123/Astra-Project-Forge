#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, utimes } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const roots = ['.codex-plugin', '.mcp.json', 'package.json', 'LICENSE', 'NOTICE.md',
  'ATTRIBUTION.md', 'README.md', 'server', 'hooks', 'skills', 'assets', 'tests', 'docs', 'scripts'];
const excluded = new Set(['node_modules', 'scratch', 'tmp', 'temp', 'data', 'state',
  'dist', 'build', 'coverage', 'artifacts']);
const timestamp = new Date('2000-01-01T00:00:00Z');

async function collect(relative) {
  const absolute = path.join(root, relative);
  const stat = await lstat(absolute);
  if (stat.isSymbolicLink()) throw new Error(`Release input cannot be a symlink: ${relative}`);
  if (stat.isFile()) return [{ relative, executable: Boolean(stat.mode & 0o111) }];
  if (!stat.isDirectory()) throw new Error(`Unsupported release input: ${relative}`);
  const result = [];
  for (const entry of (await readdir(absolute)).sort()) {
    if (entry.startsWith('.') || excluded.has(entry) || /(?:\.(?:zip|log|tmp|bak|swp)|~)$/.test(entry)) continue;
    result.push(...await collect(path.join(relative, entry)));
  }
  return result;
}

async function stageFile(source, destination, executable = false) {
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, executable ? 0o755 : 0o644);
  await utimes(destination, timestamp, timestamp);
}

async function canonicalOutput(output) {
  let ancestor = output;
  const suffix = [];
  // Resolve existing aliases physically while retaining directories not created yet.
  for (;;) {
    try {
      await lstat(ancestor);
      break;
    } catch (error) {
      const parent = path.dirname(ancestor);
      if (error.code !== 'ENOENT' || parent === ancestor) throw error;
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
  return path.join(await realpath(ancestor), ...suffix);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output-dir' || !args[1]) {
    throw new Error('Usage: node scripts/package-release.mjs --output-dir /absolute/artifact-directory');
  }
  const output = await canonicalOutput(path.resolve(args[1]));
  const relativeOutput = path.relative(await realpath(root), output);
  if (!relativeOutput || (!relativeOutput.startsWith(`..${path.sep}`) && relativeOutput !== '..' && !path.isAbsolute(relativeOutput))) {
    throw new Error('Archive output must be outside the plugin source directory');
  }
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const plugin = JSON.parse(await readFile(path.join(root, '.codex-plugin/plugin.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version) || pkg.version !== plugin.version ||
      pkg.license !== 'AGPL-3.0-only' || plugin.license !== 'AGPL-3.0-only') {
    throw new Error('Release metadata must agree on version and AGPL-3.0-only');
  }
  const inputs = [];
  for (const entry of roots) inputs.push(...await collect(entry));
  await mkdir(output, { recursive: true });
  const staging = await mkdtemp(path.join(output, '.astra-release-stage-'));
  const archives = [];
  try {
    for (const marketplace of [false, true]) {
      const top = marketplace ? `astra-project-forge-local-marketplace-${pkg.version}` : `astra-project-forge-${pkg.version}`;
      const pluginPath = marketplace ? `${top}/plugins/astra-project-forge` : top;
      const members = [];
      for (const input of inputs) {
        const member = `${pluginPath}/${input.relative.split(path.sep).join('/')}`;
        await stageFile(path.join(root, input.relative), path.join(staging, member), input.executable);
        members.push(member);
      }
      if (marketplace) {
        const member = `${top}/.agents/plugins/marketplace.json`;
        await stageFile(path.join(root, 'scripts/marketplace.json'), path.join(staging, member));
        members.push(member);
      }
      const name = `astra-project-forge-local${marketplace ? '-marketplace' : ''}-${pkg.version}.zip`;
      const archive = path.join(staging, name);
      // Stable ordering, timestamps, permissions and stripped ZIP extras make rebuilds repeatable.
      const zipped = spawnSync('zip', ['-X', '-q', archive, '-@'], {
        cwd: staging, env: { ...process.env, TZ: 'UTC' },
        input: members.sort().join('\n') + '\n', encoding: 'utf8', timeout: 30000
      });
      if (zipped.error) throw zipped.error;
      if (zipped.status !== 0) throw new Error(`zip failed: ${zipped.stderr || zipped.stdout}`);
      const destination = path.join(output, name);
      archives.push({ archive: destination, pluginPath });
    }
    // Both builds must succeed before publication; each rename is atomic, not the pair.
    for (const { archive } of archives) {
      await rename(path.join(staging, path.basename(archive)), archive);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  process.stdout.write(JSON.stringify({ version: pkg.version, archives }, null, 2) + '\n');
}

main().catch(error => {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
});
