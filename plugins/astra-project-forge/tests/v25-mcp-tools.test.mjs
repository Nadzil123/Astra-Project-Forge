import test from 'node:test';
import assert from 'node:assert/strict';
import { tools, dispatch } from '../server/mcp-server.mjs';

test('v2.5 exposes routing and selective-context tools', async () => {
  const names = tools.map(tool => tool.name);
  assert.ok(names.includes('adaptive_route_task'));
  assert.ok(names.includes('adaptive_get_context'));

  const route = await dispatch({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: {
      name: 'adaptive_route_task',
      arguments: { complexity: 'moderate', uncertainty: 'medium', continuityNeeded: true }
    }
  });
  assert.ok(route.structuredContent?.route);
  assert.notEqual(route.structuredContent.route.profile, 'off');
});
