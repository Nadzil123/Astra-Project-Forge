import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('local-only package has no Cloudflare deployment files or external npm dependencies', () => {
  assert.equal(fs.existsSync(path.join(root, 'cloudflare')), false);
  assert.equal(fs.existsSync(path.join(root, 'wrangler.jsonc')), false);
  assert.equal(fs.existsSync(path.join(root, 'server', 'http-server.mjs')), false);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.deepEqual(pkg.devDependencies ?? {}, {});
});
