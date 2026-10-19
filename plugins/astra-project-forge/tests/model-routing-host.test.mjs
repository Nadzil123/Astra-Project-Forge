import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readModelEligibility } from '../server/model-policy.mjs';

async function createAdapter(policy = readModelEligibility({})) {
  const url = new URL('../server/model-host-adapter.mjs', import.meta.url);
  assert.ok(existsSync(url), 'manual advisory host adapter must exist');
  const { createAdvisoryHostAdapter } = await import(url.href);
  assert.equal(typeof createAdvisoryHostAdapter, 'function');
  return createAdvisoryHostAdapter(policy);
}

const capabilities = {
  catalogDiscovery: 'unknown',
  turnModelSelection: 'unsupported',
  effortControl: 'unsupported',
  trustedModelIdentity: 'unknown',
  subagentModelSelection: 'unknown',
  deferredToolLoading: 'unknown',
  usageTelemetry: 'unknown',
};

test('unknown support is not an execution capability', async () => {
  const adapter = await createAdapter();
  assert.deepEqual(adapter.describe(), {
    adapterId: 'manual-v1', mode: 'advisory', observedModel: null,
    eligibility: { requiredModel: 'gpt-6.1-sol', allowedModels: ['gpt-6.1-sol'] },
    capabilities,
  });
  const handoff = adapter.prepareHandoff({
    recommendedModel: 'gpt-6.1-sol',
    trusted: { model: 'gpt-6.1-sol', canSwitch: true },
    model: 'gpt-6.1-sol', canSwitch: true,
    hostCapabilities: { turnModelSelection: 'supported', trustedModelIdentity: 'supported' },
    catalog: ['gpt-6-astra', 'gpt-6.1-sol'],
  }, null);
  assert.equal(handoff.observedModel, null);
  assert.equal(handoff.executionStatus, 'not_attempted');
  assert.equal(handoff.switched, false);
  assert.deepEqual(adapter.describe().capabilities, capabilities);
});

test('handoff is user action not observed switching', async () => {
  const adapter = await createAdapter(readModelEligibility({
    ASTRA_REQUIRED_MODEL: 'gpt-6-astra', ASTRA_ALLOWED_MODELS: 'gpt-6.1-sol',
  }));
  const capsule = { projectId: 'pilot', revision: 3, nextAction: { kind: 'verify' } };
  const handoff = adapter.prepareHandoff({ recommendedModel: 'gpt-6.1-sol' }, capsule);
  assert.equal(handoff.status, 'user_action_required');
  assert.equal(handoff.requestedModel, 'gpt-6.1-sol');
  assert.deepEqual(handoff.capsule, capsule);
  assert.equal(handoff.persistedContextStatus, 'available');
  assert.equal(handoff.observedModel, null);
  assert.equal(handoff.executionStatus, 'not_attempted');
  assert.equal(handoff.switched, false);
  assert.equal(handoff.availability, 'unknown');
  assert.equal(handoff.quota, 'unknown');
});

test('effort and deferred discovery remain independent', async () => {
  const adapter = await createAdapter(readModelEligibility({ ASTRA_REQUIRED_MODEL: 'gpt-6-astra' }));
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
    const result = adapter.prepareHandoff({
      recommendedModel: 'gpt-6-astra', effort,
      hostCapabilities: { deferredDiscovery: true, discoveryAvailable: true },
    }, null);
    assert.equal(result.executionStatus, 'not_attempted');
    assert.equal(Object.hasOwn(result, 'effort'), false);
    assert.equal(adapter.describe().capabilities.effortControl, 'unsupported');
    assert.equal(adapter.describe().capabilities.deferredToolLoading, 'unknown');
  }
});

test('caller reports and catalog cannot widen operator eligibility', async () => {
  const adapter = await createAdapter();
  for (const recommendedModel of ['gpt-6-astra', 'unknown', '', null, undefined]) {
    assert.throws(() => adapter.prepareHandoff({
      recommendedModel, trusted: true, model: 'gpt-6-astra', canSwitch: true,
      eligibility: { allowedModels: ['gpt-6-astra'] },
      catalog: ['gpt-6-astra', 'gpt-6.1-sol'],
    }, null), /eligible/i);
  }
  assert.deepEqual(adapter.describe().eligibility.allowedModels, ['gpt-6.1-sol']);
});

test('array targets cannot become mutable approved handoff models', async () => {
  const adapter = await createAdapter(readModelEligibility({ ASTRA_REQUIRED_MODEL: 'gpt-6-astra' }));
  for (const recommendedModel of [['gpt-6-astra'], [['gpt-6-astra']]]) {
    assert.throws(() => adapter.prepareHandoff({ recommendedModel }, null), TypeError);
  }
});

test('object targets are rejected before eligibility can invoke string coercion', async () => {
  const adapter = await createAdapter(readModelEligibility({ ASTRA_REQUIRED_MODEL: 'gpt-6-astra' }));
  let coercions = 0;
  const recommendedModel = { toString() { coercions++; return 'gpt-6-astra'; } };
  assert.throws(() => adapter.prepareHandoff({ recommendedModel }, null), TypeError);
  assert.equal(coercions, 0);
  assert.throws(() => adapter.prepareHandoff({ recommendedModel: new String('gpt-6-astra') }, null), TypeError);
});

test('reassigning advice cannot change the validated primitive handoff target', async () => {
  const adapter = await createAdapter(readModelEligibility({ ASTRA_REQUIRED_MODEL: 'gpt-6-astra' }));
  const advice = { recommendedModel: 'gpt-6-astra' };
  const handoff = adapter.prepareHandoff(advice, null);
  advice.recommendedModel = ['gpt-6-astra'];
  advice.recommendedModel[0] = 'gpt-6.1-sol';
  assert.equal(typeof handoff.requestedModel, 'string');
  assert.equal(handoff.requestedModel, 'gpt-6-astra');
  assert.throws(() => adapter.prepareHandoff(advice, null), TypeError);
});

test('describe isolates operator policy and capabilities from later mutations', async () => {
  const policy = readModelEligibility({ ASTRA_REQUIRED_MODEL: 'gpt-6-astra' });
  const adapter = await createAdapter(policy);
  policy.allowedModels.push('gpt-6.1-sol');
  policy.requiredModel = 'gpt-6.1-sol';
  const descriptor = adapter.describe();
  descriptor.eligibility.allowedModels.push('gpt-6.1-sol');
  descriptor.eligibility.requiredModel = 'gpt-6.1-sol';
  descriptor.capabilities.turnModelSelection = 'supported';
  assert.deepEqual(adapter.describe().eligibility, {
    requiredModel: 'gpt-6-astra', allowedModels: ['gpt-6-astra'],
  });
  assert.deepEqual(adapter.describe().capabilities, capabilities);
  assert.throws(() => adapter.prepareHandoff({ recommendedModel: 'gpt-6.1-sol' }, null), /eligible/i);
});

test('preparation preserves inputs and returns isolated repeatable handoffs', async () => {
  const policy = Object.freeze({
    requiredModel: 'gpt-6-astra', allowedModels: Object.freeze(['gpt-6-astra']),
  });
  const capsule = Object.freeze({
    projectId: 'pilot', nextAction: Object.freeze({ kind: 'verify' }),
  });
  const advice = Object.freeze({ recommendedModel: 'gpt-6-astra' });
  const adapter = await createAdapter(policy);
  const descriptor = adapter.describe();
  const first = adapter.prepareHandoff(advice, capsule);
  assert.deepEqual(adapter.prepareHandoff(advice, capsule), first);
  first.capsule.nextAction.kind = 'changed';
  assert.equal(capsule.nextAction.kind, 'verify');
  assert.equal(adapter.prepareHandoff(advice, capsule).capsule.nextAction.kind, 'verify');
  assert.deepEqual(adapter.describe(), descriptor);
  assert.deepEqual(advice, { recommendedModel: 'gpt-6-astra' });
});

test('null capsule explicitly reports unavailable persisted context', async () => {
  const adapter = await createAdapter(readModelEligibility({ ASTRA_REQUIRED_MODEL: 'gpt-6-astra' }));
  const result = adapter.prepareHandoff({ recommendedModel: 'gpt-6-astra' }, null);
  assert.equal(result.capsule, null);
  assert.equal(result.persistedContextStatus, 'unavailable');
  assert.equal(result.status, 'user_action_required');
  assert.equal(result.executionStatus, 'not_attempted');
});
