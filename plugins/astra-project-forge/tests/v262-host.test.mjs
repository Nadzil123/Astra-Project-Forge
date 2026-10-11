import test from 'node:test';
import assert from 'node:assert/strict';
import { tools } from '../server/mcp-server.mjs';

async function select(options) {
  // Fail on missing behavior, rather than an import-time module error.
  const { existsSync } = await import('node:fs');
  assert.ok(existsSync(new URL('../server/host-capabilities.mjs', import.meta.url)), 'host advice module must exist');
  const { selectCapabilities } = await import('../server/host-capabilities.mjs');
  return selectCapabilities(options);
}

test('unknown host and failed discovery retain every stable catalog capability', async () => {
  for (const hostCapabilities of [undefined, {}, { deferredDiscovery: true }, { deferredDiscovery: true, discoveryAvailable: false }, { allowedSubset: false }]) {
    const result = await select({ stage: 'evaluate', hostCapabilities });
    assert.equal(result.mode, 'stable_catalog');
    assert.deepEqual(result.selected, tools.map(tool => tool.name));
    assert.deepEqual(result.fallback, tools.map(tool => tool.name));
    assert.equal(result.advisory, true);
  }
});

test('confirmed host support suggests a reversible stage subset with context and recovery reachable', async () => {
  for (const [hostCapabilities, mode] of [
    [{ deferredDiscovery: true, discoveryAvailable: true }, 'deferred_discovery'],
    [{ allowedSubset: true }, 'allowed_subset'],
  ]) {
    const result = await select({ stage: 'evaluate', hostCapabilities });
    assert.equal(result.mode, mode);
    for (const name of ['forge_evaluate', 'forge_context', 'forge_checkpoint', 'adaptive_get_state']) assert.ok(result.selected.includes(name));
    assert.ok(result.selected.length < 19);
    assert.deepEqual(result.fallback, tools.map(tool => tool.name));
    assert.equal(result.advisory, true);
    assert.equal(result.permissionsChanged, false);
    assert.equal(result.cacheSavings, null);
  }
});

test('unsupported stages fall back and malformed host envelopes reject', async () => {
  assert.equal((await select({ stage: 'invented', hostCapabilities: { allowedSubset: true } })).mode, 'stable_catalog');
  for (const hostCapabilities of [null, [], true, { allowedSubset: 'true' }, { allowed_tools: true }]) {
    await assert.rejects(select({ stage: 'route', hostCapabilities }), /hostCapabilities/);
  }
});
