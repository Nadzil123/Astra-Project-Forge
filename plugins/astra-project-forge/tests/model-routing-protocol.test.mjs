import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as traces from '../scripts/routing-traces.mjs';
import { buildModelRoutingSnapshot, recommendModel } from '../server/model-router.mjs';
import { buildModelHandoff } from '../server/model-routing-state.mjs';
import { assessUtility, policyBudget } from '../server/efficiency-governor.mjs';
import { routingFixture, supportAllCriteria, addDependencyRisk, addFailure, routingRef } from './helpers/model-routing-fixtures.mjs';

// All contracts, reviews, graders and observations below are synthetic test data.
// They demonstrate structural checks, never comparative model quality or access.
const copy = value => structuredClone(value);
const arms = ['sol_only', 'astra_only', 'sol_first_control', 'adaptive_evidence'];
const slots = [
  ['routine-parser', 'routine-implementation'], ['routine-filter', 'routine-implementation'],
  ['debug-span', 'ordinary-debugging'], ['debug-nested-call', 'ordinary-debugging'],
  ['multi-manifest', 'multi-file-change'], ['multi-record', 'multi-file-change'],
  ['ambiguous-permission', 'ambiguous-failure'], ['ambiguous-eof', 'ambiguous-failure'],
  ['migration-unknown', 'state-migration'], ['migration-replay', 'state-migration'],
  ['architecture-gate', 'architecture'], ['architecture-layout', 'architecture'],
  ['long-package', 'long-agentic-work'], ['long-recovery', 'long-agentic-work'],
  ['risk-corrupt', 'risk-weighted-verification'], ['risk-counterevidence', 'risk-weighted-verification'],
];
const controls = Object.fromEntries(['sourceReference', 'taskInputsReference', 'promptReference',
  'graderReference', 'policyReference', 'dependenciesReference', 'permissionsReference',
  'toolSchemaReference', 'eligibilityReference', 'featureFlagsReference'].map(name => [name, `fixture:${name}`]));
const floor = ['mandatory_criteria', 'required_regressions', 'no_critical_false_success', 'no_new_critical_failure'];
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const manifest = name => ({ reference: `fixture:${name}`, sha256: digest(name) });
function seal(campaign) {
  const { freezeCommitment, ...content } = campaign;
  campaign.freezeCommitment = digest(content);
  return campaign;
}
function campaignFixture() {
  return seal({
    version: 1, campaignId: 'synthetic-protocol', status: 'frozen',
    provenance: { kind: 'synthetic', reference: 'fixture:protocol-only' },
    strategies: copy(arms), repetitions: [1, 2, 3], schedulingSeed: 731,
    cacheStratumByRepetition: ['cold', 'warm', 'cold'], controls: copy(controls),
    arms: arms.map((strategy, i) => ({ strategy, controls: copy(controls), verificationFloor: copy(floor),
      initialModel: i === 1 ? 'astra' : i === 3 ? 'policy' : 'sol',
      escalation: i < 2 ? 'never' : i === 2 ? 'first_failed_verification_or_unchanged_failed_strategy' : 'evidence_based' })),
    policy: { manifest: manifest('policy'), tunedOnEvaluation: false },
    reviews: { readinessReference: 'fixture:readiness-review', spendingReference: 'fixture:spending-review',
      graderIndependenceReference: 'fixture:independence-review' },
    calibrationTasks: [{ taskId: 'calibration-only', contentIdentity: digest('calibration-content'), manifest: manifest('calibration') }],
    tasks: slots.map(([taskId, category], i) => ({ taskId, category,
      split: i % 4 === 0 ? 'out_of_domain' : 'held_out', criticality: i >= 8 ? 'critical' : 'ordinary',
      contentIdentity: digest(`content:${taskId}`), requiredChecks: ['artifact', 'required-suite'],
      frozen: Object.fromEntries(['source', 'task', 'prompt', 'grader', 'artifacts'].map(name => [name, manifest(`${taskId}:${name}`)])),
      grader: { kind: category === 'architecture' ? 'blinded_rubric' : 'executable', independent: true,
        hiddenReviewReference: 'fixture:hidden-grader-review',
        calibrationReviewReference: category === 'architecture' ? 'fixture:rubric-calibration' : null,
        humanAgreementReviewReference: category === 'architecture' ? 'fixture:human-agreement' : null },
    })),
  });
}
function validate(value) {
  assert.equal(typeof traces.validateRoutingCampaign, 'function', 'missing campaign contract validator');
  return traces.validateRoutingCampaign(value);
}
function schedule(value) {
  assert.equal(typeof traces.buildRoutingSchedule, 'function', 'missing paired campaign scheduler');
  return traces.buildRoutingSchedule(value);
}
function reportFixture() {
  const campaign = campaignFixture();
  const assignments = schedule(campaign);
  const base = JSON.parse(readFileSync(new URL('./fixtures/routing/trace-cases.json', import.meta.url), 'utf8'));
  const reportManifest = { version: 1, campaignId: campaign.campaignId, provenance: copy(campaign.provenance),
    tasks: campaign.tasks.map(({ taskId, category, criticality }) => ({ taskId, category, criticality })),
    strategies: copy(arms), repetitions: [1, 2, 3], controls: copy(controls), routingCampaign: campaign };
  const values = assignments.map((assignment, i) => {
    const trace = copy(base.traces[1]);
    Object.assign(trace, { campaignId: campaign.campaignId, taskId: assignment.taskId, strategy: assignment.strategy,
      repetition: assignment.repetition, runId: `synthetic-${i}`, campaignBinding: copy(assignment.binding) });
    trace.verification = copy(base.traces[0].verification);
    trace.verification.grader.reference = campaign.tasks.find(t => t.taskId === trace.taskId).frozen.grader.reference;
    trace.verification.grader.kind = trace.taskId.startsWith('architecture-') ? 'blinded_rubric' : 'executable';
    Object.assign(trace.attempts[0], { requestedModel: assignment.strategy === 'astra_only' ? 'gpt-6-astra' : 'gpt-6.1-sol',
      observedModel: assignment.strategy === 'astra_only' ? 'gpt-6-astra' : 'gpt-6.1-sol', outcome: 'success', cacheState: 'unknown' });
    if (trace.taskId === 'long-recovery') trace.attempts[0].metrics.recoveryCorrect = true;
    return trace;
  });
  return { campaign, manifest: reportManifest, traces: values };
}
const report = data => traces.summarizeRoutingTraces(data.traces, data.manifest);
const assessment = (result, kind = 'synthetic') => result.assessments.find(row => row.evidenceKind === kind);
const route = (f, signals = {}) => recommendModel(buildModelRoutingSnapshot(f.project, f.request, signals), f.request, f.runtime);

function appendModelAttempt(trace, requestedModel, observedModel = requestedModel) {
  const id = `model-${trace.attempts.length + 1}`;
  trace.attempts.push({ ...copy(trace.attempts.at(-1)), id, requestedModel, observedModel });
  for (const scope of ['attempt', 'tool', 'handoff']) trace.chargeCoverage.required.push({
    id: `${id}-${scope}`, scope, reference: id, accountingSystem: 'api_money', currency: 'USD',
  });
  trace.resourceCharges.push({ id: `${id}-charge`, scope: 'attempt', reference: id,
    accountingSystem: 'api_money', currency: 'USD', amount: '5',
    includes: ['attempt', 'tool', 'handoff'].map(scope => `${id}-${scope}`),
    provenance: { kind: 'synthetic', reference: `fixture:${id}-charge` } });
}

for (const strategy of ['adaptive_evidence', 'sol_first_control']) {
  test(`${strategy}: unsupported observed identities violate the campaign floor and retain raw costs`, () => {
    const data = reportFixture(); const trace = data.traces.find(row => row.strategy === strategy);
    if (strategy === 'sol_first_control') appendModelAttempt(trace, 'unapproved-third-model');
    else Object.assign(trace.attempts[0], { requestedModel: 'unapproved-third-model', observedModel: 'unapproved-third-model' });
    const result = report(data); const selected = assessment(result);
    assert.equal(selected.protocol.status, 'violation'); assert.equal(selected.quality.floorSatisfied, false);
    assert.equal(selected.quality.veto, false);
    assert.ok(selected.protocol.issues.some(row => row.reason === 'model_deviation' && row.field.endsWith('.observedModel') && row.severity === 'violation'));
    assert.deepEqual(result.trajectories.find(row => row.runId === trace.runId), trace);
    assert.equal(result.trajectories.length, 192); assert.equal(selected.cohort.complete, true);
    const costs = result.strata.find(row => row.strategy === strategy).costs;
    assert.equal(costs[0].knownSubtotal, strategy === 'sol_first_control' ? '245' : '240');
    assert.equal(costs[0].unitCostReason, 'protocol_not_satisfied');
    assert.equal(costs[0].costPerVerifiedResult, null);
  });

  test(`${strategy}: unsupported requests are violations even with unknown observations`, () => {
    for (const observedModel of [null, 'gpt-6.1-sol']) {
      const data = reportFixture(); const trace = data.traces.find(row => row.strategy === strategy);
      if (strategy === 'sol_first_control') appendModelAttempt(trace, 'unapproved-third-model', observedModel);
      else Object.assign(trace.attempts[0], { requestedModel: 'unapproved-third-model', observedModel });
      const selected = assessment(report(data));
      assert.equal(selected.protocol.status, 'violation'); assert.equal(selected.quality.floorSatisfied, false);
      assert.ok(selected.protocol.issues.some(row => row.reason === 'model_deviation' && row.field.endsWith('.requestedModel') && row.severity === 'violation'));
      if (observedModel === null) assert.ok(selected.protocol.issues.some(row => row.reason === 'model_unobserved'));
    }
  });

  test(`${strategy}: unsupported observed switch sources and destinations never count`, () => {
    for (const [source, destination] of [
      ['gpt-6.1-sol', 'unapproved-third-model'], ['unapproved-third-model', 'gpt-6-astra'],
      ['unapproved-third-model', 'another-unapproved-model'],
    ]) {
      const data = reportFixture(); const trace = data.traces.find(row => row.strategy === strategy);
      if (strategy === 'sol_first_control') appendModelAttempt(trace, source);
      else Object.assign(trace.attempts[0], { requestedModel: source, observedModel: source });
      appendModelAttempt(trace, destination);
      const selected = assessment(report(data));
      assert.equal(selected.protocol.observedSwitches, 0);
      assert.equal(selected.protocol.status, 'violation'); assert.equal(selected.quality.floorSatisfied, false);
    }
  });
}

test('supported adaptive/control transitions count both directions while null observations stay inconclusive', () => {
  for (const strategy of ['adaptive_evidence', 'sol_first_control']) {
    const data = reportFixture(); const trace = data.traces.find(row => row.strategy === strategy);
    appendModelAttempt(trace, 'gpt-6-astra'); appendModelAttempt(trace, 'gpt-6.1-sol');
    let selected = assessment(report(data));
    assert.equal(selected.protocol.observedSwitches, 2);
    assert.equal(selected.protocol.status, 'consistent_observations'); assert.equal(selected.quality.floorSatisfied, true);
    trace.attempts[1].observedModel = null;
    selected = assessment(report(data));
    assert.equal(selected.protocol.observedSwitches, 0);
    assert.equal(selected.protocol.status, 'inconclusive'); assert.equal(selected.quality.floorSatisfied, false);
    assert.ok(selected.protocol.issues.some(row => row.reason === 'model_unobserved'));
  }
});

test('fixed arms and the initial control attempt retain their stricter supported-model rules', () => {
  for (const strategy of ['sol_only', 'astra_only', 'sol_first_control']) {
    const data = reportFixture(); const trace = data.traces.find(row => row.strategy === strategy);
    const other = strategy === 'astra_only' ? 'gpt-6.1-sol' : 'gpt-6-astra';
    if (strategy !== 'sol_first_control') appendModelAttempt(trace, other);
    else Object.assign(trace.attempts[0], { requestedModel: other, observedModel: other });
    const selected = assessment(report(data));
    assert.equal(selected.protocol.status, 'violation'); assert.equal(selected.quality.floorSatisfied, false);
  }
});

test('draft campaign cannot claim readiness; freeze and spending failures are named together', () => {
  const value = campaignFixture();
  value.status = 'draft'; value.freezeCommitment = null;
  value.reviews.readinessReference = null; value.reviews.spendingReference = null;
  value.tasks[0].frozen.grader = null;
  assert.throws(() => validate(value), error => {
    assert.match(error.message, /missing_freeze/);
    assert.match(error.message, /missing_spending_review/);
    assert.match(error.message, /missing_readiness_review/);
    return true;
  });
});

test('paired schedule has every arm once per task repetition and exactly 192 offline assignments', () => {
  const value = campaignFixture(); const before = copy(value);
  const result = schedule(value);
  assert.equal(result.length, 192); assert.deepEqual(value, before);
  assert.deepEqual(result, schedule(copy(value)));
  const changed = schedule(seal({ ...copy(value), schedulingSeed: 732 }));
  const membership = rows => rows.map(({ taskId, repetition, strategy }) => `${taskId}/${repetition}/${strategy}`).sort();
  assert.deepEqual(membership(result), membership(changed));
  assert.notDeepEqual(result.map(x => x.strategy), changed.map(x => x.strategy));
  for (const [taskId] of slots) for (const repetition of [1, 2, 3]) {
    const block = result.filter(row => row.taskId === taskId && row.repetition === repetition);
    assert.deepEqual(block.map(row => row.strategy).sort(), [...arms].sort());
    assert.ok(block.every(row => row.assignedCacheStratum === (repetition === 2 ? 'warm' : 'cold')));
  }
  assert.equal(result.filter(row => row.assignedCacheStratum === 'cold').length, 128);
  for (const row of result) {
    assert.equal(row.mode, 'offline'); assert.equal(row.executionAuthorized, false);
    assert.equal(row.executionStatus, 'not_attempted');
    assert.equal(row.binding.campaignCommitment, value.freezeCommitment);
  }
  const detached = validate(value); detached.tasks[0].taskId = 'mutated'; assert.deepEqual(value, before);
});

test('manifest drift or missing grader rejects; a status label or recomputed digest is not enough', () => {
  const drift = campaignFixture(); drift.tasks[0].frozen.source.sha256 = digest('changed');
  assert.throws(() => validate(drift), /manifest_drift/);
  for (const mutate of [
    c => { c.tasks[0].frozen.grader = null; },
    c => { c.tasks[10].grader.humanAgreementReviewReference = null; },
    c => { c.tasks[0].grader.independent = false; },
    c => { c.reviews.graderIndependenceReference = null; },
    c => { c.policy.manifest = null; },
  ]) {
    const value = campaignFixture(); mutate(value); seal(value);
    assert.throws(() => validate(value), /grader|agreement|independen|freeze/i);
  }
});

test('evaluation/calibration identities and content stay separate; shared source alone is allowed', () => {
  for (const mutate of [
    c => { c.calibrationTasks[0].taskId = c.tasks[0].taskId; },
    c => { c.calibrationTasks[0].contentIdentity = c.tasks[0].contentIdentity; },
    c => { c.tasks[1].contentIdentity = c.tasks[0].contentIdentity; },
    c => { c.policy.tunedOnEvaluation = true; },
    c => { c.tasks.forEach(t => { t.split = 'held_out'; }); },
    c => { c.tasks.pop(); },
  ]) {
    const value = campaignFixture(); mutate(value); seal(value);
    assert.throws(() => validate(value), /overlap|tuning|split|slots/);
  }
  const value = campaignFixture();
  value.tasks.forEach(t => { t.frozen.source = copy(value.tasks[0].frozen.source); });
  assert.equal(validate(seal(value)).tasks.length, 16);
});

test('four arms share eligibility tools and verification; control is not the production retry policy', () => {
  for (const field of ['eligibilityReference', 'toolSchemaReference', 'permissionsReference', 'featureFlagsReference']) {
    const value = campaignFixture(); value.arms[3].controls[field] = 'fixture:confounded';
    assert.throws(() => validate(seal(value)), /shared_controls/);
  }
  const value = campaignFixture(); value.arms[2].verificationFloor.pop();
  assert.throws(() => validate(seal(value)), /verification_floor/);
  const wrong = campaignFixture(); wrong.arms[3].escalation = wrong.arms[2].escalation;
  assert.throws(() => validate(seal(wrong)), /strategy_rule/);
  assert.equal(route(addFailure(routingFixture())).policyAction, 'REQUEST_USER_CHOICE');
  assert.equal(route(addDependencyRisk(routingFixture())).policyAction, 'ESCALATE_ASTRA');
});

test('bound report enforces manifest matrix and returns per-class coverage and assigned cache strata', () => {
  const data = reportFixture(); const result = report(data); const selected = assessment(result);
  assert.equal(selected.cohort.complete, true); assert.equal(selected.quality.floorSatisfied, true);
  assert.equal(selected.protocol.status, 'consistent_observations');
  assert.equal(selected.protocol.classes.length, 8);
  assert.ok(selected.protocol.classes.every(row => row.expectedBlocks === 24 && row.observedBlocks === 24 && row.failures === 0));
  assert.deepEqual(selected.protocol.cacheStrata.map(row => [row.assignedCacheStratum, row.expectedBlocks]), [['cold', 128], ['warm', 64]]);
  assert.equal(selected.protocol.ordinaryNonInferiority, 'unresolved_pending_preregistration');
  assert.equal(selected.protocol.sampleAdequacy, 'inconclusive');
  assert.equal(result.empiricalSavings, null); assert.equal(selected.quality.efficiencyClaimAllowed, false);
  data.manifest.tasks.pop(); assert.throws(() => report(data), /campaign_manifest_mismatch/);
});

test('unknown observation cannot pass a campaign quality gate; malformed bindings reject, drift remains visible', () => {
  const missing = reportFixture(); delete missing.traces[0].campaignBinding;
  let result = report(missing);
  assert.equal(assessment(result).quality.floorSatisfied, false);
  assert.equal(assessment(result).protocol.status, 'inconclusive');
  assert.equal(result.trajectories.length, 192);
  const data = reportFixture(); data.traces[0].campaignBinding.controls.toolSchemaReference = 'fixture:changed-schema';
  result = report(data);
  assert.equal(assessment(result).protocol.status, 'violation');
  assert.ok(assessment(result).protocol.issues.some(row => row.reason === 'binding_drift'));
  assert.equal(result.trajectories[0].campaignBinding.controls.toolSchemaReference, 'fixture:changed-schema');
  data.traces[0].campaignBinding.manifests.grader = null;
  assert.equal(assessment(report(data)).quality.floorSatisfied, false);
  data.traces[0].campaignBinding = { campaignCommitment: 1 };
  assert.throws(() => report(data), /campaignBinding/);
});

test('adversarial 1: hidden migration invariant and negative artifact grader override claimed success', () => {
  const data = reportFixture(); const trace = data.traces.find(t => t.taskId === 'migration-replay');
  trace.agentClaimedSuccess = true; trace.verification.mandatoryCriteria[0].passed = false;
  trace.verification.verified = false; trace.verification.falseSuccess = true;
  const result = report(data); const selected = assessment(result);
  assert.equal(selected.quality.veto, true); assert.equal(selected.quality.floorSatisfied, false);
  assert.ok(result.strata.every(row => row.costs.every(cost => cost.unitCostReason === 'quality_veto')));
  assert.equal(selected.protocol.classes.find(row => row.category === 'state-migration').failures, 1);
  trace.verification.verified = true;
  assert.throws(() => report(data), /true requires independent/);
});

test('adversarial 2: difficult wording with cheap exact checks does not imply an Astra win', () => {
  const f = routingFixture({ project: { goal: 'extremely difficult compiler architecture rewrite' } });
  assert.equal(route(f).policyAction, 'KEEP_SOL');
  supportAllCriteria(f.project);
  const advice = route(f); assert.equal(advice.policyAction, 'COMPLETE');
  assert.equal(advice.assessmentSource, 'reported'); assert.equal(advice.observedModel, null);
  const data = reportFixture(); data.traces[0].verification.grader = null; data.traces[0].verification.verified = null;
  assert.equal(assessment(report(data)).quality.floorSatisfied, false);
});

test('adversarial 3: new wording without new evidence cannot restart failed strategy loops', () => {
  const f = addFailure(routingFixture());
  f.request.nextHypothesis = { strategyKey: 'same-strategy renamed', changedEvidenceRefs: [],
    changedConditions: ['old parser configuration'], discriminatingCheck: 'try it again differently' };
  assert.equal(route(f).policyAction, 'REQUEST_USER_CHOICE');
  const utility = assessUtility({ repeatsFailedStrategyWithoutNewEvidence: true, candidateWouldMakeProgress: true });
  assert.equal(utility.decision, 'skip');
  assert.ok(utility.wasteReasons.includes('repeated_failed_strategy'));
});

test('adversarial 4: useful mandatory verifier continues beyond budget with justification', () => {
  const { softCycleBudget } = policyBudget('balanced', 'standard');
  const utility = assessUtility({ completedCycles: softCycleBudget + 1, softCycleBudget,
    successCriteriaSatisfied: false, candidateWouldVerifySuccessCriterion: true });
  assert.equal(utility.decision, 'allow'); assert.equal(utility.requiresJustification, true);
  assert.ok(utility.usefulReasons.includes('unmet_success_criterion'));
  const f = routingFixture(); f.project.efficiency.completedCycles = softCycleBudget + 1;
  assert.notEqual(route(f).policyAction, 'COMPLETE');
  const data = reportFixture(); data.traces[0].verification.mandatoryCriteria[0].passed = null;
  data.traces[0].verification.verified = null;
  assert.equal(assessment(report(data)).quality.floorSatisfied, false);
});

test('adversarial 5: forbidden/unavailable Astra, missing destination, quota and recovery failures remain outcomes', () => {
  const f = addDependencyRisk(routingFixture({ request: { forbiddenModels: ['gpt-6-astra'] } }));
  assert.equal(route(f).action, 'REQUEST_USER_CHOICE'); assert.notEqual(route(f).recommendedModel, 'gpt-6-astra');
  const advice = route(addDependencyRisk(routingFixture()));
  assert.equal(advice.executionStatus, 'not_attempted'); assert.equal(advice.observedModel, null);
  const data = reportFixture(); const trace = data.traces[0];
  trace.attempts.push({ ...copy(trace.attempts[0]), id: 'destination', requestedModel: 'gpt-6-astra', observedModel: null,
    outcome: 'quota', metrics: { ...copy(trace.attempts[0].metrics), recoveryCorrect: false } });
  trace.verification.verified = null;
  const result = report(data); const protocol = assessment(result).protocol;
  assert.equal(protocol.observedSwitches, 0); assert.equal(assessment(result).quality.floorSatisfied, false);
  assert.ok(protocol.issues.some(row => row.reason === 'model_unobserved'));
  assert.ok(protocol.issues.some(row => row.reason === 'recovery_failed'));
  assert.equal(result.trajectories.flatMap(t => t.attempts).filter(a => a.outcome === 'quota').length, 1);
  assert.ok(result.strata.some(row => row.coverageIssues.some(issue => issue.reason === 'missing_coverage_declaration')));
});

test('adversarial 6: older contradictions, stale references, same-ID replacement and conflicting replay survive', () => {
  const f = routingFixture(); supportAllCriteria(f.project);
  assert.notEqual(route(f, { contradictionRemaining: true }).policyAction, 'COMPLETE');
  f.project.claims.push({ id: 'older-policy', revision: 1, statement: 'Migration preserves the original invariant',
    status: 'contradicted', evidenceIds: [], counterEvidenceIds: ['check-1'] });
  f.request.receiverCanResolveReferences = false;
  const handoff = buildModelHandoff(f.project, route(f), f.request);
  assert.ok(handoff.contradictions.some(row => row.claimId === 'older-policy'));
  assert.ok(handoff.referenceBodies.some(row => row.record?.evidenceId === 'check-1'));
  f.project.claims = [];
  const oldRef = routingRef('evidence', f.project.efficiency.evidenceCache[0].key);
  f.project.efficiency.evidenceCache[0].result = { synthetic: true, changed: true };
  f.project.efficiency.evidenceCache[0].revision = 2;
  assert.notEqual(route(f).policyAction, 'COMPLETE');
  const staleHandoff = buildModelHandoff(f.project, { ...route(f), evidenceRefs: [oldRef] }, f.request);
  assert.equal(staleHandoff.incomplete, true);
  assert.ok(staleHandoff.references.some(row => row.status === 'stale'));
  const stale = addDependencyRisk(routingFixture()); stale.request.benefit.refs = [routingRef('plan', 'missing-plan')];
  assert.equal(route(stale).policyAction, 'DEFER_ESCALATION');
  const data = reportFixture(); const negative = copy(data.traces[0]); negative.runId = 'retained-old-contradiction';
  negative.verification.verified = false; negative.verification.regressions[0].passed = false;
  data.traces.push(negative);
  const result = report(data); assert.equal(result.trajectories.length, 193);
  assert.equal(assessment(result).quality.veto, true);
  const replacement = copy(data.traces[0]); replacement.attempts[0].contextReference = 'fixture:replacement';
  data.traces.push(replacement); assert.throws(() => report(data), /conflicting replay/);
});

test('adversarial 7: paired warm assignment is not a cache hit; schema drift and priming costs are retained', () => {
  const data = reportFixture(); const trace = data.traces.find(t => t.repetition === 2);
  trace.campaignBinding.controls.toolSchemaReference = 'fixture:expanded-schema';
  trace.resourceCharges[0].amount = '17';
  const result = report(data); const selected = assessment(result);
  assert.equal(selected.protocol.status, 'violation');
  assert.equal(result.trajectories.find(t => t.runId === trace.runId).attempts[0].cacheState, 'unknown');
  assert.equal(result.trajectories.find(t => t.runId === trace.runId).attempts[0].usage, null);
  assert.equal(selected.protocol.cacheStrata.find(row => row.assignedCacheStratum === 'warm').costs[0].knownSubtotal, '332');
  assert.equal(result.empiricalSavings, null);
});

test('adversarial 8: repeated capsule expansion and storage inflation count every rerun and charge', () => {
  const data = reportFixture(); const trace = data.traces[0];
  trace.attempts[0].metrics.contextExpansions = 9; trace.attempts[0].metrics.coordinationBytes = 90000;
  trace.resourceCharges[0].amount = '9';
  const rerun = copy(trace); rerun.runId = 'inflated-rerun'; rerun.resourceCharges[0].amount = '11'; data.traces.push(rerun);
  const result = report(data); const stratum = result.strata.find(row => row.strategy === trace.strategy);
  assert.equal(result.trajectories.length, 193); assert.equal(stratum.verifiedResults, 48);
  assert.equal(stratum.costs[0].knownSubtotal, '255');
  assert.equal(result.trajectories.filter(t => t.taskId === trace.taskId && t.repetition === trace.repetition && t.strategy === trace.strategy)
    .reduce((n, t) => n + t.attempts[0].metrics.contextExpansions, 0), 18);
  assert.equal(assessment(result).quality.efficiencyClaimAllowed, false);
});

test('campaign-bound mixed evidence keeps Task6 per-kind aliases, missing blocks and cross-strategy veto', () => {
  const data = reportFixture(); data.manifest.provenance.kind = 'imported';
  data.manifest.routingCampaign.provenance.kind = 'imported'; seal(data.manifest.routingCampaign);
  const imported = copy(data.traces[0]); imported.runId = 'fixture-labeled-imported';
  imported.provenance.kind = 'imported'; imported.verification.provenance.kind = 'imported';
  imported.resourceCharges.forEach(c => { c.provenance.kind = 'imported'; });
  imported.campaignBinding.campaignCommitment = data.manifest.routingCampaign.freezeCommitment;
  data.traces.forEach(t => { t.campaignBinding.campaignCommitment = data.manifest.routingCampaign.freezeCommitment; });
  data.traces.push(imported);
  const result = report(data);
  assert.equal(result.cohort, null); assert.equal(result.quality, null); assert.equal(result.summaryEvidenceKind, null);
  assert.equal(assessment(result, 'imported').cohort.observedBlocks, 1);
  assert.equal(assessment(result, 'imported').quality.floorSatisfied, false);
  assert.equal(assessment(result).cohort.complete, true);
  const failure = data.traces.find(t => t.strategy === 'astra_only');
  failure.verification.verified = false; failure.verification.criticalFailure = true;
  const vetoed = report(data);
  assert.equal(assessment(vetoed).quality.veto, true);
  assert.equal(assessment(vetoed, 'imported').quality.veto, false);
  assert.ok(vetoed.strata.filter(row => row.evidenceKind === 'synthetic').every(row => row.costs.every(cost => cost.unitCostReason === 'quality_veto')));
});

test('recovered earlier failures stay in operational totals without erasing independently verified completion', () => {
  const data = reportFixture(); const trace = data.traces[0];
  const retry = copy(trace.attempts[0]); retry.id = 'retry';
  trace.attempts[0].outcome = 'error'; trace.attempts.push(retry);
  for (const scope of ['attempt', 'tool', 'handoff']) trace.chargeCoverage.required.push({ id: `retry-${scope}`,
    scope, reference: 'retry', accountingSystem: 'api_money', currency: 'USD' });
  trace.resourceCharges.push({ id: 'retry-charge', scope: 'attempt', reference: 'retry',
    accountingSystem: 'api_money', currency: 'USD', amount: '7', includes: ['retry-attempt', 'retry-tool', 'retry-handoff'],
    provenance: { kind: 'synthetic', reference: 'fixture:retry-charge' } });
  const result = report(data); const selected = assessment(result);
  assert.equal(selected.quality.floorSatisfied, true);
  assert.equal(selected.protocol.status, 'consistent_observations');
  assert.ok(selected.protocol.issues.some(row => row.reason === 'outcome_not_success' && row.severity === 'operational'));
  assert.equal(result.strata.find(row => row.strategy === trace.strategy).costs[0].knownSubtotal, '247');
});

test('missing recovery observations and unknown shared controls cannot establish the protected floor', () => {
  const data = reportFixture(); const recovery = data.traces.find(t => t.taskId === 'long-recovery');
  recovery.attempts[0].metrics.recoveryCorrect = null;
  let selected = assessment(report(data));
  assert.equal(selected.quality.floorSatisfied, false); assert.equal(selected.protocol.status, 'inconclusive');
  assert.ok(selected.protocol.issues.some(row => row.reason === 'recovery_unobserved'));
  recovery.attempts[0].metrics.recoveryCorrect = true;
  recovery.campaignBinding.controls.eligibilityReference = null;
  selected = assessment(report(data));
  assert.equal(selected.quality.floorSatisfied, false);
  assert.ok(selected.protocol.issues.some(row => row.field === 'controls.eligibilityReference'));
});

test('CLI modes are exclusive, portable from unrelated CWD, offline, and reject the committed draft by name', () => {
  const cli = fileURLToPath(new URL('../scripts/benchmark-routing.mjs', import.meta.url));
  const draft = fileURLToPath(new URL('../docs/model-routing-campaign.json', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'routing-protocol-'));
  try {
    const path = join(dir, 'synthetic.json'); writeFileSync(path, JSON.stringify(campaignFixture()));
    const run = args => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' });
    for (const mode of ['--validate-campaign', '--schedule']) {
      const result = run([mode, path]); assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.mode, 'offline'); assert.equal(output.executionAuthorized, false);
      assert.equal(output.executionStatus, 'not_attempted');
      if (mode === '--schedule') assert.equal(output.assignments.length, 192);
    }
    for (const args of [[], ['--schedule'], ['--schedule', path, '--schedule', path],
      ['--schedule', path, '--validate-campaign', path], ['--schedule', path, '--traces', path],
      ['--validate-campaign', path, '--manifest', path]]) assert.equal(run(args).status, 1);
    const rejected = run(['--validate-campaign', draft]); assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /missing_freeze/); assert.match(rejected.stderr, /missing_spending_review/);
    assert.match(rejected.stderr, /missing_readiness_review/);
    assert.match(rejected.stderr, /execution unauthorized; not attempted/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
