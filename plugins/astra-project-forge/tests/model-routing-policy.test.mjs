import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

async function loadPolicy() {
  const moduleUrl = new URL('../server/model-policy.mjs', import.meta.url);
  assert.equal(existsSync(moduleUrl), true, 'missing server/model-policy.mjs');
  const policy = await import(moduleUrl.href);
  for (const name of ['readModelEligibility', 'isEligibleModel', 'readRoutingMode']) {
    assert.equal(typeof policy[name], 'function', `missing export ${name}`);
  }
  return policy;
}

test('default policy admits only Sol and denies Astra and unknown', async () => {
  const { readModelEligibility, isEligibleModel } = await loadPolicy();
  const policy = readModelEligibility({});
  assert.deepEqual(policy, { requiredModel: 'gpt-6.1-sol', allowedModels: ['gpt-6.1-sol'] });
  assert.equal(isEligibleModel(policy, ' GPT-6.1-SOL '), true);
  for (const model of ['gpt-6-astra', 'unknown', 'unrecognized-model', '', '  ', null, undefined]) {
    assert.equal(isEligibleModel(policy, model), false, `must reject ${model}`);
  }
  const unknownPolicy = readModelEligibility({ ASTRA_ALLOWED_MODELS: 'unknown' });
  assert.equal(isEligibleModel(unknownPolicy, 'unknown'), false);
});

test('explicit Astra required model keeps Astra eligible without admitting Sol', async () => {
  const { readModelEligibility, isEligibleModel } = await loadPolicy();
  const policy = readModelEligibility({ ASTRA_REQUIRED_MODEL: ' GPT-6-ASTRA ' });
  assert.deepEqual(policy, { requiredModel: 'gpt-6-astra', allowedModels: ['gpt-6-astra'] });
  assert.equal(isEligibleModel(policy, 'gpt-6-astra'), true);
  assert.equal(isEligibleModel(policy, 'gpt-6.1-sol'), false);
});

test('explicit eligibility normalizes and deduplicates operator settings', async () => {
  const { readModelEligibility, isEligibleModel } = await loadPolicy();
  const env = {
    ASTRA_REQUIRED_MODEL: ' GPT-6-ASTRA ',
    ASTRA_ALLOWED_MODELS: ' GPT-6.1-SOL, gpt-6-astra,,GPT-6.1-SOL, ',
  };
  const policy = readModelEligibility(env);
  assert.deepEqual(policy, {
    requiredModel: 'gpt-6-astra', allowedModels: ['gpt-6-astra', 'gpt-6.1-sol'],
  });
  assert.equal(isEligibleModel(policy, ' GPT-6.1-SOL '), true);
  assert.equal(isEligibleModel(policy, 'gpt-6-astra'), true);
  assert.equal(isEligibleModel(policy, 'unrecognized-model'), false);
  assert.equal(env.ASTRA_REQUIRED_MODEL, ' GPT-6-ASTRA ');
});

test('future required slug remains eligible and blank required slug uses the default', async () => {
  const { readModelEligibility, isEligibleModel } = await loadPolicy();
  const policy = readModelEligibility({
    ASTRA_REQUIRED_MODEL: ' Future-Astra-Slug ', ASTRA_ALLOWED_MODELS: 'gpt-6.1-sol',
  });
  assert.deepEqual(policy, {
    requiredModel: 'future-astra-slug', allowedModels: ['future-astra-slug', 'gpt-6.1-sol'],
  });
  assert.equal(isEligibleModel(policy, 'future-astra-slug'), true);
  assert.equal(isEligibleModel(policy, 'gpt-6-astra'), false);
  assert.deepEqual(readModelEligibility({ ASTRA_REQUIRED_MODEL: '  ', ASTRA_ALLOWED_MODELS: ' ,' }), {
    requiredModel: 'gpt-6.1-sol', allowedModels: ['gpt-6.1-sol'],
  });
});

test('routing advice does not enable eligibility', async () => {
  const { readModelEligibility, isEligibleModel, readRoutingMode } = await loadPolicy();
  assert.equal(readRoutingMode({}), 'off');
  assert.equal(readRoutingMode({ ASTRA_FORGE_MODEL_ROUTING: 'off' }), 'off');
  const env = { ASTRA_FORGE_MODEL_ROUTING: 'advisory-v1' };
  assert.equal(readRoutingMode(env), 'advisory-v1');
  for (const mode of ['off', 'advisory-v1']) {
    const policy = readModelEligibility({ ASTRA_FORGE_MODEL_ROUTING: mode });
    assert.deepEqual(policy.allowedModels, ['gpt-6.1-sol']);
    assert.equal(isEligibleModel(policy, 'gpt-6.1-sol'), true);
    assert.equal(isEligibleModel(policy, 'gpt-6-astra'), false);
  }
  assert.equal(readRoutingMode({ ASTRA_ALLOWED_MODELS: 'gpt-6-astra,gpt-6.1-sol' }), 'off');
  for (const value of ['', 'on', 'advisory-v2', 'ADVISORY-V1', ' off ', null, 1]) {
    assert.throws(() => readRoutingMode({ ASTRA_FORGE_MODEL_ROUTING: value }), /ASTRA_FORGE_MODEL_ROUTING/);
  }
});
