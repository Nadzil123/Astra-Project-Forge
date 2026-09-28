import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../server/state-store.mjs';
import { selectDelta } from '../server/context-efficiency.mjs';
import * as agentState from '../server/agent-state.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'astra-v261-strategy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ProjectStore(dir);
  await store.initializeProject({ projectId: 'p', goal: 'Verify without repeated failed work' });
  const file = path.join(dir, (await readdir(dir)).find(name => name.endsWith('.json')));
  return { store, dir, file, disk: () => readFile(file, 'utf8') };
}

const planInput = (patch = {}) => ({
  action: 'Run parser probe', why: 'Resolve parser uncertainty',
  strategyKey: 'parser-same-config', ...patch,
});

async function fail(store, plan, outcome = 'falsified', patch = {}) {
  return store.addEvaluation('p', {
    planId: plan.id, outcome, summary: 'Configuration mismatch', ...patch,
  });
}

for (const outcome of ['falsified', 'blocked']) {
  test(`${outcome} strategy rejects unchanged normalized retries across restart without writing`, async t => {
    const { store, dir, disk } = await fixture(t);
    const first = await store.addPlan('p', planInput({ strategyKey: '  parser-same-config  ' }));
    await fail(store, first, outcome);
    const before = await disk();
    const restarted = new ProjectStore(dir);
    for (const strategyKey of ['parser-same-config', ' parser-same-config ']) {
      await assert.rejects(restarted.addPlan('p', planInput({ strategyKey })), /failed strategy/i);
      assert.equal(await disk(), before);
    }
  });

  test(`${outcome} evaluation persists failure cause, retry condition and revision without rewriting metadata`, async t => {
    const { store, dir, file, disk } = await fixture(t);
    const plan = await store.addPlan('p', planInput({ newEvidenceIds: [' ev-config '], changedConditions: ' config-v2 ' }));
    const raw = JSON.parse(await disk());
    raw.plans[0].vendor = { keep: true };
    raw.efficiency.vendor = 'retained';
    raw.efficiency.failedStrategies.push({ strategy: 'legacy', extra: { keep: true } });
    await writeFile(file, JSON.stringify(raw));
    const before = await store.getProject('p');
    const evaluation = await fail(store, plan, outcome, { evidenceIds: ['external-test-result'] });
    const project = await new ProjectStore(dir).getProject('p');
    const memory = project.efficiency.failedStrategies;
    assert.equal(memory.length, 2);
    assert.deepEqual(memory[0], before.efficiency.failedStrategies[0]);
    assert.equal(memory[1].strategyKey, 'parser-same-config');
    assert.equal(memory[1].status, 'failed');
    assert.equal(memory[1].cause, 'Configuration mismatch');
    assert.match(memory[1].retryAllowedWhen, /new evidence|changed conditions/i);
    assert.equal(memory[1].planId, plan.id);
    assert.equal(memory[1].evaluationId, evaluation.id);
    assert.equal(memory[1].outcome, outcome);
    assert.deepEqual(memory[1].newEvidenceIds, ['ev-config', 'external-test-result']);
    assert.equal(memory[1].changedConditions, 'config-v2');
    assert.equal(memory[1].revision, evaluation.revision);
    assert.equal(memory[1].revision, project.revision);
    assert.deepEqual(selectDelta(memory, before.revision), [memory[1]]);
    assert.deepEqual(project.plans[0], before.plans[0]);
    assert.equal(project.efficiency.vendor, 'retained');
    await store.addObservation('p', { observation: 'unrelated' });
    assert.deepEqual((await store.getProject('p')).efficiency.failedStrategies, memory);
  });
}

test('opaque new evidence permits retry but failed evidence cannot be recycled or alternated', async t => {
  const { store, dir } = await fixture(t);
  const first = await store.addPlan('p', planInput());
  await fail(store, first, 'falsified', { evidenceIds: ['ev-original-failure'] });
  const retry = await store.addPlan('p', planInput({ newEvidenceIds: [' ev-dependency-change '] }));
  assert.deepEqual(retry.newEvidenceIds, ['ev-dependency-change']);
  await fail(store, retry, 'blocked');
  const restarted = new ProjectStore(dir);
  for (const newEvidenceIds of [[], [' '], ['ev-dependency-change'], [' ev-dependency-change ', 'ev-original-failure']]) {
    await assert.rejects(restarted.addPlan('p', planInput({ newEvidenceIds })), /failed strategy/i);
  }
  const next = await restarted.addPlan('p', planInput({ newEvidenceIds: ['ev-dependency-change', 'ev-config-fixed'] }));
  await fail(restarted, next);
  await assert.rejects(restarted.addPlan('p', planInput({ newEvidenceIds: ['ev-dependency-change'] })), /failed strategy/i);
  await assert.rejects(restarted.addPlan('p', planInput({ newEvidenceIds: ['ev-config-fixed', 'ev-dependency-change'] })), /failed strategy/i);
});

test('changed conditions permit retry but the same failed condition cannot be recycled', async t => {
  const { store } = await fixture(t);
  await fail(store, await store.addPlan('p', planInput()));
  const retry = await store.addPlan('p', planInput({ changedConditions: ' dependency-v2 ' }));
  assert.equal(retry.changedConditions, 'dependency-v2');
  await fail(store, retry);
  await assert.rejects(store.addPlan('p', planInput({ changedConditions: ' dependency-v2 ' })), /failed strategy/i);
  const next = await store.addPlan('p', planInput({ changedConditions: 'dependency-v3' }));
  await fail(store, next);
  await assert.rejects(store.addPlan('p', planInput({ changedConditions: 'dependency-v2' })), /failed strategy/i);
  const newEvidence = await store.addPlan('p', planInput({ changedConditions: 'dependency-v2', newEvidenceIds: ['new-probe'] }));
  assert.deepEqual(newEvidence.newEvidenceIds, ['new-probe']);
});

test('failure memory is project-local and a different strategy remains actionable', async t => {
  const { store } = await fixture(t);
  await fail(store, await store.addPlan('p', planInput()));
  await store.initializeProject({ projectId: 'other', goal: 'Independent project' });
  const independent = await store.addPlan('other', planInput());
  assert.equal(independent.strategyKey, 'parser-same-config');
  const changed = await store.addPlan('p', planInput({ strategyKey: 'instrument-lookahead' }));
  assert.equal(changed.strategyKey, 'instrument-lookahead');
  await assert.rejects(store.addPlan('p', planInput()), /failed strategy/i);
  assert.deepEqual((await store.getProject('other')).efficiency.failedStrategies, []);
});

test('non-failure evaluations and unkeyed legacy plans retain v2.6 behavior', async t => {
  const { store } = await fixture(t);
  for (const outcome of ['verified', 'partially_verified', 'inconclusive']) {
    const plan = await store.addPlan('p', planInput());
    await fail(store, plan, outcome);
  }
  for (let i = 0; i < 2; i += 1) {
    const plan = await store.addPlan('p', planInput({ strategyKey: undefined }));
    await fail(store, plan);
  }
  await store.addEvaluation('p', { outcome: 'blocked', summary: 'No plan attached' });
  const project = await store.getProject('p');
  assert.equal(project.plans.length, 5);
  assert.equal(project.evaluations.length, 6);
  assert.deepEqual(project.efficiency.failedStrategies, []);
  assert.equal(project.observations.length, 0);
});

test('historical failed evaluations still guard retries when failure memory is absent', async t => {
  const { store, file, disk } = await fixture(t);
  const plan = await store.addPlan('p', planInput());
  await fail(store, plan);
  const raw = JSON.parse(await disk());
  raw.plans[0].strategyKey = ' parser-same-config ';
  raw.plans[0].newEvidenceIds = ['ev-old'];
  raw.plans[0].changedConditions = 'old-condition';
  raw.efficiency.failedStrategies = [];
  await writeFile(file, JSON.stringify(raw));
  await assert.rejects(store.addPlan('p', planInput({ newEvidenceIds: ['ev-old'], changedConditions: 'old-condition' })), /failed strategy/i);
  const retry = await store.addPlan('p', planInput({ newEvidenceIds: ['external-fix'] }));
  assert.equal(retry.strategyKey, 'parser-same-config');
});

test('persisted failure memory guards retries independently of raw plan history', async t => {
  const { store, file, disk } = await fixture(t);
  const raw = JSON.parse(await disk());
  raw.efficiency.failedStrategies = [{
    id: 'failure-old', strategyKey: ' parser-same-config ', status: 'failed',
    cause: 'Earlier failure', retryAllowedWhen: 'new evidence or changed conditions',
    newEvidenceIds: ['ev-old'], changedConditions: 'old-condition', vendor: 'keep',
  }];
  await writeFile(file, JSON.stringify(raw));
  await assert.rejects(store.addPlan('p', planInput({ newEvidenceIds: ['ev-old'], changedConditions: 'old-condition' })), /failed strategy/i);
  await store.addPlan('p', planInput({ changedConditions: 'new-condition' }));
  assert.deepEqual((await store.getProject('p')).efficiency.failedStrategies, raw.efficiency.failedStrategies);
});

test('invalid strategy and retry markers reject without changing persisted state', async t => {
  const { store, disk } = await fixture(t);
  for (const patch of [
    { strategyKey: '' }, { strategyKey: 7 }, { strategyKey: ' ' },
    { newEvidenceIds: 'ev' }, { newEvidenceIds: [7] },
    { changedConditions: '' }, { changedConditions: ' ' }, { changedConditions: true },
  ]) {
    const before = await disk();
    await assert.rejects(store.addPlan('p', planInput(patch)), /strategyKey|newEvidenceIds|changedConditions/);
    assert.equal(await disk(), before);
  }
});

test('verification guidance scales with risk and preserves existing plan fields across restart', async t => {
  const { store, dir } = await fixture(t);
  const cases = [
    [{}, 'low', 'low', 'light', 'medium'],
    [{ risk: 'low' }, 'low', 'low', 'light', 'medium'],
    [{ risk: 'medium' }, 'medium', 'medium', 'standard', 'medium'],
    [{ risk: 'high' }, 'high', 'high', 'strong', 'medium'],
    [{ verificationRisk: 'medium' }, 'low', 'medium', 'standard', 'medium'],
    [{ verificationRisk: 'high' }, 'low', 'high', 'strong', 'medium'],
    [{ risk: 'high', verificationRisk: 'low' }, 'high', 'low', 'strong', 'medium'],
    [{ risk: 'medium', verificationRisk: 'low' }, 'medium', 'low', 'standard', 'medium'],
    [{ reversible: false, verificationRisk: 'low' }, 'low', 'low', 'strong', 'medium'],
    [{ expectedDecisionImpact: 'high', verificationRisk: 'low' }, 'low', 'low', 'strong', 'high'],
    [{ expectedDecisionImpact: 'none' }, 'low', 'low', 'light', 'none'],
    [{ expectedDecisionImpact: 'low' }, 'low', 'low', 'light', 'low'],
    [{ expectedDecisionImpact: 'typo' }, 'low', 'low', 'light', 'medium'],
  ];
  for (const [patch, risk, verificationRisk, strength, impact] of cases) {
    const input = planInput({ goalId: 'goal-root', expectedEvidence: 'Probe output', usageImpact: 'MODERATE', ...patch });
    const plan = await store.addPlan('p', input);
    assert.equal(plan.verificationStrength, strength, JSON.stringify(patch));
    assert.equal(plan.verificationRisk, verificationRisk);
    assert.equal(plan.expectedDecisionImpact, impact);
    assert.equal(plan.risk, risk);
    assert.equal(plan.reversible, input.reversible !== false);
    for (const key of ['action', 'why', 'goalId', 'expectedEvidence', 'usageImpact']) {
      assert.equal(plan[key], input[key], key);
    }
    assert.equal(plan.status, 'planned');
    assert.deepEqual(plan.newEvidenceIds, []);
    assert.equal(plan.changedConditions, null);
    assert.deepEqual((await new ProjectStore(dir).getProject('p')).plans.at(-1), plan);
  }
});

test('verification risk uses existing strict risk validation without writing invalid plans', async t => {
  const { store, disk } = await fixture(t);
  for (const field of ['verificationRisk', 'risk']) {
    for (const value of ['typo', '', 'HIGH', 7, false, {}, []]) {
      const before = await disk();
      await assert.rejects(store.addPlan('p', planInput({ [field]: value })), /risk must be low, medium, or high/i);
      assert.equal(await disk(), before);
    }
  }
});

test('verificationStrength exposes conservative guidance for omitted and unknown risk', () => {
  assert.equal(typeof agentState.verificationStrength, 'function');
  assert.equal(agentState.verificationStrength(), 'standard');
  assert.equal(agentState.verificationStrength('low'), 'light');
  assert.equal(agentState.verificationStrength('medium'), 'standard');
  assert.equal(agentState.verificationStrength('high'), 'strong');
  assert.equal(agentState.verificationStrength('unknown'), 'standard');
});
