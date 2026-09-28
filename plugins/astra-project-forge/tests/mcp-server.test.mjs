import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.resolve(here, '../server/mcp-server.mjs');

function createRpcClient(child) {
  let nextId = 1;
  let buffer = '';
  const pending = new Map();

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    while (true) {
      const idx = buffer.indexOf('\n');
      if (idx < 0) break;
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id != null && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    }
  });

  return {
    request(method, params = {}) {
      const id = nextId++;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`timeout waiting for ${method}`));
          }
        }, 3000).unref();
      });
    },
    notify(method, params = {}) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    }
  };
}

test('exposes real MCP tools and persists an adaptive project state', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'astra-project-forge-mcp-'));
  const child = spawn(process.execPath, [server, '--stdio'], {
    env: { ...process.env, ASTRA_PROJECT_FORGE_DATA_DIR: dataDir },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const stderr = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => stderr.push(chunk));
  const rpc = createRpcClient(child);

  try {
    const init = await rpc.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    assert.equal(init.serverInfo.name, 'astra-project-forge');
    assert.equal(init.capabilities.tools.listChanged, false);
    rpc.notify('notifications/initialized');

    const list = await rpc.request('tools/list');
    const names = list.tools.map(t => t.name);
    assert.ok(names.includes('adaptive_initialize_project'));
    assert.ok(names.includes('adaptive_record_experiment'));
    assert.ok(names.includes('adaptive_consolidate'));
    assert.ok(names.includes('adaptive_get_state'));

    const created = await rpc.request('tools/call', {
      name: 'adaptive_initialize_project',
      arguments: {
        projectId: 'compiler-lab',
        goal: 'Improve parser reliability',
        mode: 'deep',
        successCriteria: ['all parser tests pass']
      }
    });
    assert.equal(created.structuredContent.project.mode, 'deep');

    await rpc.request('tools/call', {
      name: 'adaptive_record_observation',
      arguments: {
        projectId: 'compiler-lab',
        observation: 'Failure appears only for nested generics',
        confidence: 0.8
      }
    });

    const stateResult = await rpc.request('tools/call', {
      name: 'adaptive_get_state',
      arguments: { projectId: 'compiler-lab' }
    });
    assert.equal(stateResult.structuredContent.project.observations.length, 1);
    assert.equal(stateResult.isError, undefined);
    assert.equal(stderr.join(''), '');
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
