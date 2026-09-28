import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve('.');

test('skill documents adaptive routing, capability awareness, and selective retrieval', () => {
  const skill = readFileSync(path.join(root, 'skills', 'astra-project-forge', 'SKILL.md'), 'utf8');
  assert.match(skill, /adaptive routing/i);
  assert.match(skill, /selective state retrieval/i);
  assert.match(skill, /available capabilities/i);
  assert.match(skill, /workflow budget/i);
  assert.match(skill, /do not treat.*actual token/i);
});
