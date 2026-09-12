import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.ASTRA_PROJECT_FORGE_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'astra-v26-usage-'));
const { dispatch } = await import('../server/mcp-server.mjs');

test.after(async () => rm(process.env.ASTRA_PROJECT_FORGE_DATA_DIR, { recursive: true, force: true }));

test('forge_route signals first-use and first-deep notices until acknowledged', async () => {
  const projectId = 'usage-project';
  await dispatch({ method: 'tools/call', params: { name: 'adaptive_initialize_project', arguments: { projectId, goal: 'Complex work' } } });

  const first = await dispatch({ method: 'tools/call', params: { name: 'forge_route', arguments: {
    projectId, complexity: 'complex', uncertainty: 'high', continuityNeeded: true, repeatedFailure: true, crossDomain: true
  } } });
  assert.equal(first.structuredContent.noticeRequired, true);
  assert.equal(first.structuredContent.deepNoticeRequired, true);

  await dispatch({ method: 'tools/call', params: { name: 'forge_adapt', arguments: {
    projectId, operation: 'acknowledge_usage', firstUseNoticeAcknowledged: true, deepWarningAcknowledged: true
  } } });

  const second = await dispatch({ method: 'tools/call', params: { name: 'forge_route', arguments: {
    projectId, complexity: 'complex', uncertainty: 'high', continuityNeeded: true, repeatedFailure: true, crossDomain: true
  } } });
  assert.equal(second.structuredContent.noticeRequired, false);
  assert.equal(second.structuredContent.deepNoticeRequired, false);
});
