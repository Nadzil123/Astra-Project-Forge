import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

async function text(path) { return readFile(new URL(path, import.meta.url), 'utf8'); }

test('release metadata identifies v2.6.0 and AGPL-3.0', async () => {
  const pkg = JSON.parse(await text('../package.json'));
  const plugin = JSON.parse(await text('../.codex-plugin/plugin.json'));
  assert.equal(pkg.version, '2.6.0');
  assert.equal(plugin.version, '2.6.0');
  assert.match(plugin.license, /^AGPL-3\.0/);
});

test('ships AGPL, notice, and proportional attribution policy without a trademark policy', async () => {
  const license = await text('../LICENSE');
  const notice = await text('../NOTICE.md');
  const attribution = await text('../ATTRIBUTION.md');
  assert.match(license, /GNU AFFERO GENERAL PUBLIC LICENSE/);
  assert.match(license, /Version 3, 19 November 2007/);
  assert.match(notice, /Astra Project Forge contributors/);
  assert.match(notice, /Nadzil123\/Astra-Project-Forge/);
  assert.match(attribution, /Direct Fork/i);
  assert.match(attribution, /Substantial Derivative/i);
  assert.match(attribution, /Multiple Components/i);
  assert.match(attribution, /Single Component/i);
  assert.match(attribution, /Small Code Portion/i);
  assert.match(attribution, /Independent Reimplementation/i);
  await assert.rejects(access(new URL('../TRADEMARKS.md', import.meta.url)));
});

test('README contains the universal English Usage & Cost Notice and v2.6 concepts', async () => {
  const readme = await text('../README.md');
  assert.match(readme, /Usage & Cost Notice/);
  assert.match(readme, /may increase overall model usage compared with using Astra without this plugin/i);
  assert.match(readme, /does\s+\*\*not\*\*\s+change\s+the\s+model['’]s\s+base\s+pricing/i);
  assert.match(readme, /Goal Graph/i);
  assert.match(readme, /Epistemic/i);
  assert.match(readme, /MINIMAL.*LOW.*MODERATE.*HIGH.*VERY HIGH/is);
});

test('skill documents general adaptive agent behavior without claiming AGI', async () => {
  const skill = await text('../skills/astra-project-forge/SKILL.md');
  assert.match(skill, /Goal graph/i);
  assert.match(skill, /Known.*Inferred.*Unknown.*Contradicted/is);
  assert.match(skill, /transfer/i);
  assert.match(skill, /recovery/i);
  assert.match(skill, /Usage.*Cost/i);
  assert.match(skill, /does not.*AGI|not.*AGI/i);
});
