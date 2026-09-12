import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const input = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'startup-test', version: '1' }
  } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
    name: 'adaptive_list_projects', arguments: {}
  } }
].map(message => JSON.stringify(message)).join('\n') + '\n';

function verifyStartup(command, args, cwd, dataDir) {
  const result = spawnSync(command, args, {
    cwd, env: { ...process.env, ASTRA_PROJECT_FORGE_DATA_DIR: dataDir },
    input, encoding: 'utf8', timeout: 5000
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(result.stdout.trim(), 'Server exited without an initialize response');
  const replies = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(replies.map(reply => reply.id), [1, 2, 3]);
  assert.equal(replies[0].result.serverInfo.name, 'astra-project-forge');
  const names = replies[1].result.tools.map(tool => tool.name);
  assert.ok(names.includes('adaptive_list_projects'));
  assert.ok(names.includes('adaptive_get_state'));
  assert.equal(replies[2].result.isError, undefined);
  assert.deepEqual(replies[2].result.structuredContent.projects, []);
}

test('launches the MCP entry with plugin-relative cwd and literal arguments, as observed in Codex 0.153.4', async () => {
  const config = JSON.parse(await readFile(path.join(root, '.mcp.json'), 'utf8'));
  const entry = config.mcpServers?.['astra-project-forge'];
  assert.ok(entry, 'The MCP companion file must expose a mcpServers map');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'astra-config-test-'));
  try {
    // Codex resolves cwd relative to the installed plugin root. It does not
    // expand the hook-only PLUGIN_ROOT placeholder in this MCP configuration.
    verifyStartup(entry.command, entry.args, path.resolve(root, entry.cwd ?? '.'), dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('initializes from an installation path containing spaces and URL characters', async () => {
  const install = await mkdtemp(path.join(tmpdir(), 'astra plugin +% é-'));
  try {
    await cp(path.join(root, 'server'), path.join(install, 'server'), { recursive: true });
    verifyStartup(process.execPath, [path.join(install, 'server/mcp-server.mjs'), '--stdio'],
      tmpdir(), path.join(install, 'test-data'));
  } finally {
    await rm(install, { recursive: true, force: true });
  }
});
