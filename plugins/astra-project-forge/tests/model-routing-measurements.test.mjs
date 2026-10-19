import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const fixture = JSON.parse(await readFile(new URL('./fixtures/routing/trace-cases.json', import.meta.url), 'utf8'));
const copy = value => structuredClone(value);
const fresh = () => copy(fixture);
async function api() {
  const url = new URL('../scripts/routing-traces.mjs', import.meta.url);
  assert.ok(existsSync(url), 'missing offline trace validator/aggregator scripts/routing-traces.mjs');
  return import(url.href);
}
async function report(data = fresh()) {
  return (await api()).summarizeRoutingTraces(data.traces, data.manifest);
}
const cost = result => result.strata[0].costs.find(row => row.accountingSystem === 'api_money' && row.currency === 'USD' && row.evidenceKind === 'synthetic');
function allVerified(data) {
  for (const trace of data.traces) trace.verification = copy(data.traces[0].verification);
}
function oneMore(data) {
  const trace = copy(data.traces[0]);
  trace.taskId = 'three'; trace.runId = 'run-three';
  data.manifest.tasks.push({ taskId: 'three', category: 'ordinary-debugging', criticality: 'ordinary' });
  data.traces.push(trace);
}

function labelEvidence(trace, kind) {
  trace.provenance.kind = kind;
  trace.verification.provenance.kind = kind;
  for (const charge of trace.resourceCharges) charge.provenance.kind = kind;
}

// Reviewer-made arithmetic only: imported/observed labels exercise isolation,
// and do not turn these fixture records into real provider or grader evidence.
function qualityCase(kind) {
  const data = fresh();
  data.manifest.provenance.kind = kind;
  data.traces = data.manifest.tasks.map(task => {
    const trace = copy(fixture.traces[1]);
    trace.taskId = task.taskId; trace.runId = `q1-${task.taskId}`;
    trace.attempts[0].outcome = 'success';
    trace.verification = copy(fixture.traces[0].verification);
    trace.resourceCharges[0].amount = '1';
    labelEvidence(trace, kind);
    return trace;
  });
  return data;
}

test('Q1: synthetic or estimate tasks cannot complete imported or observed campaign assessments', async () => {
  for (const kind of ['imported', 'observed']) {
    for (const otherKind of ['synthetic', 'estimate']) {
      const data = qualityCase(kind); labelEvidence(data.traces[1], otherKind);
      const result = await report(data);
      assert.notEqual(result.cohort?.complete, true, 'foreign evidence must not complete a real cohort');
      assert.notEqual(result.quality?.floorSatisfied, true, 'foreign evidence must not satisfy a real quality floor');
      assert.equal(result.summaryEvidenceKind, null);
      assert.equal(result.cohort, null);
      assert.equal(result.quality, null);
      const real = result.assessments.find(row => row.evidenceKind === kind);
      assert.equal(real.cohort.expectedBlocks, 2);
      assert.equal(real.cohort.observedBlocks, 1);
      assert.equal(real.cohort.complete, false);
      assert.deepEqual(real.cohort.missing, [{ taskId: 'two', repetition: 1, strategy: 'fixture-control' }]);
      assert.equal(real.quality.floorSatisfied, false);
      assert.equal(real.quality.veto, false);
      assert.equal(result.assessments.find(row => row.evidenceKind === otherKind).cohort.complete, false);
      assert.equal(result.trajectories.length, 2);
      assert.equal(result.strata.find(row => row.evidenceKind === kind).costs[0].allInTotal, null);
      assert.equal(result.strata.find(row => row.evidenceKind === kind).costs[0].knownSubtotal, '1');
    }
    const data = qualityCase(kind);
    const single = await report(data);
    assert.equal(single.summaryEvidenceKind, kind);
    assert.deepEqual(single.cohort, single.assessments[0].cohort);
    assert.deepEqual(single.quality, single.assessments[0].quality);
    assert.equal(single.cohort.complete, true);
    assert.equal(single.quality.floorSatisfied, true);
    data.traces = [];
    const empty = await report(data);
    assert.equal(empty.summaryEvidenceKind, kind);
    assert.equal(empty.cohort.observedBlocks, 0);
    assert.equal(empty.cohort.complete, false);
    assert.equal(empty.quality.floorSatisfied, false);
    const synthetic = qualityCase(kind).traces;
    for (const trace of synthetic) labelEvidence(trace, 'synthetic');
    data.traces = synthetic;
    const absentKind = await report(data);
    assert.equal(absentKind.cohort, null);
    assert.equal(absentKind.assessments.find(row => row.evidenceKind === kind).cohort.observedBlocks, 0);
    assert.equal(absentKind.assessments.find(row => row.evidenceKind === kind).quality.floorSatisfied, false);
  }
});

test('Q1: foreign-kind vetoes leave real costs unchanged while same-kind vetoes cover every strategy', async () => {
  for (const kind of ['imported', 'observed']) {
    for (const otherKind of ['synthetic', 'estimate']) {
      for (const failure of ['falseSuccess', 'criticalFailure', 'regressions']) {
        const data = qualityCase(kind); const before = await report(data);
        assert.equal(before.strata[0].costs[0].allInTotal, '2');
        assert.equal(before.strata[0].costs[0].costPerVerifiedResult.exactDecimal, '1');
        const negative = copy(data.traces[0]); negative.runId = 'q1-foreign-failure';
        labelEvidence(negative, otherKind); negative.verification.verified = false;
        if (failure === 'regressions') negative.verification.regressions[0].passed = false;
        else negative.verification[failure] = true;
        data.traces.push(negative);
        const after = await report(data);
        const real = after.strata.find(row => row.evidenceKind === kind);
        assert.deepEqual(real.costs, before.strata[0].costs, 'foreign failure must not change real cost or unit cost');
        assert.equal(real.costs[0].unitCostReason, null);
        assert.deepEqual(after.assessments.find(row => row.evidenceKind === kind), before.assessments[0]);
        const other = after.assessments.find(row => row.evidenceKind === otherKind);
        assert.equal(other.quality.veto, true);
        assert.deepEqual(other.quality.vetoes.map(row => row.runId), ['q1-foreign-failure']);
        assert.equal(after.trajectories.find(trace => trace.runId === 'q1-foreign-failure').verification.verified, false);
        assert.equal(after.strata.find(row => row.evidenceKind === otherKind).costs[0].unitCostReason, 'quality_veto');
        assert.equal(after.cohort, null); assert.equal(after.quality, null);

        data.manifest.strategies.push('other-control');
        const sameKind = copy(negative); sameKind.runId = 'q1-same-kind-failure';
        sameKind.strategy = 'other-control'; labelEvidence(sameKind, kind);
        data.traces.push(sameKind);
        const vetoed = await report(data);
        const assessment = vetoed.assessments.find(row => row.evidenceKind === kind);
        assert.equal(assessment.quality.veto, true);
        assert.deepEqual(assessment.quality.vetoes.map(row => row.runId), ['q1-same-kind-failure']);
        for (const stratum of vetoed.strata.filter(row => row.evidenceKind === kind)) {
          assert.equal(stratum.costs[0].costPerVerifiedResult, null);
          assert.equal(stratum.costs[0].unitCostReason, 'quality_veto');
        }
        assert.equal(vetoed.strata.find(row => row.evidenceKind === kind && row.strategy === 'fixture-control').costs[0].allInTotal, '2');
        assert.equal(vetoed.trajectories.length, 4);
      }
    }
  }
});

test('all attempts count toward verified-result cost (deterministic synthetic arithmetic)', async () => {
  const result = await report();
  assert.equal(result.mode, 'offline');
  assert.equal(result.localGradingExecuted, false);
  assert.equal(result.empiricalSavings, null);
  assert.equal(result.defaultChangeAuthorized, false);
  assert.equal(result.strata[0].attemptCount, 3);
  assert.equal(result.strata[0].verifiedResults, 1);
  assert.equal(cost(result).knownSubtotal, '10');
  assert.equal(cost(result).allInTotal, '10');
  assert.deepEqual(cost(result).costPerVerifiedResult, {
    numerator: '10', denominator: '1', exactDecimal: '10', display: '10', rounding: null,
  });
  assert.equal(result.strata[0].evidenceKind, 'synthetic');
  assert.equal(result.quality.floorSatisfied, false); // Failed mandatory criterion is retained.
  assert.equal(result.quality.efficiencyClaimAllowed, false);
});

test('zero completions has undefined unit cost while fully observed zero stays zero', async () => {
  const data = fresh();
  for (const trace of data.traces) {
    trace.verification.verified = false;
    for (const charge of trace.resourceCharges) charge.amount = '0';
  }
  const row = cost(await report(data));
  assert.equal(row.allInTotal, '0');
  assert.equal(row.costPerVerifiedResult, null);
  assert.equal(row.unitCostReason, 'zero_verified_results');
});

test('missing telemetry is not zero, including the failed attempt charge', async () => {
  const data = fresh(); data.traces[1].resourceCharges[0].amount = null;
  const result = await report(data);
  assert.equal(cost(result).knownSubtotal, '5');
  assert.equal(cost(result).allInTotal, null);
  assert.equal(cost(result).costPerVerifiedResult, null);
  assert.equal(cost(result).unitCostReason, 'incomplete_cost_coverage');
  assert.ok(cost(result).missingResources.some(row => row.resourceId === 'c-provider'));
  assert.equal(result.trajectories[1].attempts[0].usage, null);
  assert.equal(result.trajectories[1].attempts[0].metrics.contextBytes, null);
  assert.ok(result.strata[0].coverageIssues.some(issue => issue.runId === 'run-two' && issue.resourceId === 'c-provider' && issue.reason === 'unknown_charge_amount'));
});

test('an entirely unobserved cost subtotal stays null and missing charges identify the resource', async () => {
  const data = fresh();
  for (const trace of data.traces) trace.resourceCharges = [];
  const result = await report(data);
  assert.equal(cost(result).knownSubtotal, null);
  assert.equal(cost(result).allInTotal, null);
  assert.ok(result.strata[0].coverageIssues.some(issue => issue.runId === 'run-two' && issue.resourceId === 'c-provider' && issue.reason === 'missing_charge'));
});

for (const item of fixture.exactSums) {
  test(`exact decimal sum ${item.amounts.join(' + ')} = ${item.total}`, async () => {
    const data = fresh(); let index = 0;
    for (const trace of data.traces) for (const charge of trace.resourceCharges) charge.amount = item.amounts[index++];
    assert.equal(cost(await report(data)).allInTotal, item.total);
  });
}

test('non-terminating unit cost retains its exact ratio and names display rounding', async () => {
  const data = fresh(); oneMore(data); allVerified(data);
  for (const trace of data.traces) for (const charge of trace.resourceCharges) charge.amount = '0';
  data.traces[0].resourceCharges[0].amount = '1';
  const row = cost(await report(data));
  assert.equal(row.allInTotal, '1');
  assert.equal(row.costPerVerifiedResult.numerator, '1');
  assert.equal(row.costPerVerifiedResult.denominator, '3');
  assert.equal(row.costPerVerifiedResult.exactDecimal, null);
  assert.equal(row.costPerVerifiedResult.display, '0.333333');
  assert.deepEqual(row.costPerVerifiedResult.rounding, { mode: 'half_up', decimalPlaces: 6 });
  assert.equal(row.unitCostReason, null);
});

test('terminating quotients and rounded carries use exact integer arithmetic', async () => {
  const data = fresh(); allVerified(data);
  data.traces[0].resourceCharges[0].amount = '0.1';
  data.traces[0].resourceCharges[1].amount = '0.2';
  data.traces[1].resourceCharges[0].amount = '0';
  assert.equal(cost(await report(data)).costPerVerifiedResult.exactDecimal, '0.15');
  oneMore(data); allVerified(data);
  for (const trace of data.traces) for (const charge of trace.resourceCharges) charge.amount = '0';
  data.traces[0].resourceCharges[0].amount = '2.9999999';
  assert.equal(cost(await report(data)).costPerVerifiedResult.display, '1.000000');
});

test('billing systems, currencies, and estimated versus invoiced charges cannot be mixed', async () => {
  const data = fresh();
  for (const resource of data.traces[1].chargeCoverage.required) {
    resource.accountingSystem = 'product_credits'; resource.currency = null;
  }
  Object.assign(data.traces[1].resourceCharges[0], { accountingSystem: 'product_credits', currency: null });
  const extra = copy(data.traces[0].resourceCharges[0]);
  extra.id = 'estimate'; extra.amount = '99';
  extra.provenance = { kind: 'estimate', reference: 'fixture:externally-supplied-estimate' };
  data.traces[0].resourceCharges.push(extra);
  let result = await report(data);
  assert.equal(cost(result).allInTotal, '5');
  assert.equal(result.strata[0].costs.find(row => row.accountingSystem === 'product_credits').allInTotal, '5');
  assert.equal(result.strata[0].costs.find(row => row.evidenceKind === 'estimate').knownSubtotal, '99');
  assert.equal(result.strata[0].costs.find(row => row.evidenceKind === 'estimate').allInTotal, null);
  for (const resource of data.traces[1].chargeCoverage.required) {
    resource.accountingSystem = 'included_subscription'; resource.currency = null;
  }
  Object.assign(data.traces[1].resourceCharges[0], { accountingSystem: 'included_subscription', currency: null, amount: null });
  result = await report(data);
  assert.equal(result.strata[0].costs.find(row => row.accountingSystem === 'included_subscription').allInTotal, null);
  for (const resource of data.traces[1].chargeCoverage.required) {
    resource.accountingSystem = 'api_money'; resource.currency = 'EUR';
  }
  Object.assign(data.traces[1].resourceCharges[0], { accountingSystem: 'api_money', currency: 'EUR', amount: '7' });
  result = await report(data);
  assert.equal(result.strata[0].costs.find(row => row.currency === 'EUR').allInTotal, '7');
  assert.equal(cost(result).allInTotal, '5');
});

test('critical false success and regression failure veto a unit-cost claim across strategies', async () => {
  for (const field of ['falseSuccess', 'criticalFailure', 'regressions']) {
    const data = fresh();
    if (field === 'regressions') data.traces[1].verification.regressions[0].passed = false;
    else data.traces[1].verification[field] = true;
    const result = await report(data);
    assert.equal(result.quality.veto, true);
    assert.equal(cost(result).allInTotal, '10');
    assert.equal(cost(result).costPerVerifiedResult, null);
    assert.equal(cost(result).unitCostReason, 'quality_veto');
  }
});

test('replayed trace identity counts once; conflicting replay is rejected regardless of key order', async () => {
  const data = fresh();
  data.traces.push(Object.fromEntries(Object.entries(copy(data.traces[0])).reverse()));
  const result = await report(data);
  assert.equal(result.duplicateRecords, 1);
  assert.equal(cost(result).allInTotal, '10');
  data.traces[2].resourceCharges[0].amount = '8';
  await assert.rejects(report(data), /conflicting replay.*run-one/i);
});

test('reruns retain costs and provenance without multiplying verified task/repetition results', async () => {
  const data = fresh();
  const rerun = copy(data.traces[0]); rerun.runId = 'rerun-one';
  rerun.provenance.reference = 'fixture:rerun-after-outage';
  data.traces.push(rerun);
  const result = await report(data);
  assert.equal(result.strata[0].verifiedResults, 1);
  assert.equal(cost(result).allInTotal, '15');
  assert.equal(result.pairedOutcomes[0].outcomes[0].runIds.length, 2);
});

test('reasoning/output and cache-write/input subsets are preserved without token addition or byte conversion', async () => {
  const data = fresh(); const usage = copy(data.traces[0].attempts[1].usage);
  data.traces[0].attempts[0].metrics.contextBytes = 999999;
  const result = await report(data);
  assert.deepEqual(result.trajectories[0].attempts[1].usage, usage);
  assert.equal(result.trajectories[0].attempts[0].usage, null);
  assert.equal(cost(result).allInTotal, '10');
  const { validateRoutingTrace } = await api();
  data.traces[0].attempts[1].usage.reasoningTokens = 51;
  assert.throws(() => validateRoutingTrace(data.traces[0]), /subset/i);
});

test('overlapping provider total and separately listed tool fee is rejected', async () => {
  const data = fresh(); const fee = copy(data.traces[0].resourceCharges[1]);
  Object.assign(fee, { id: 'tool-fee', scope: 'tool', includes: ['b-tools'] });
  data.traces[0].resourceCharges.push(fee);
  await assert.rejects(report(data), /overlap.*b-tools/i);
});

test('missing coverage declarations, omitted charges and explicit exclusions remain incomplete', async () => {
  for (const mode of ['declaration', 'charge', 'exclusion']) {
    const data = fresh();
    if (mode === 'charge') data.traces[1].resourceCharges = [];
    else {
      data.traces[1].chargeCoverage.required = [];
      data.traces[1].resourceCharges = [];
      if (mode === 'exclusion') data.traces[1].chargeCoverage.exclusions = [
        { scope: 'attempt', reference: 'c', reason: 'provider did not expose billing' },
      ];
    }
    const result = await report(data);
    assert.equal(cost(result).allInTotal, null);
    assert.ok(result.strata[0].coverageIssues.length > 0);
  }
});

test('missing independent grader and unobserved verification cannot establish completion', async () => {
  const data = fresh();
  data.traces[0].verification.grader = null;
  data.traces[0].verification.verified = null;
  data.traces[0].verification.regressions[0].passed = null;
  const result = await report(data);
  assert.equal(result.strata[0].verifiedResults, 0);
  assert.equal(result.quality.floorSatisfied, false);
  assert.equal(result.trajectories[0].verification.verified, null);
  data.traces[0].verification.verified = true;
  await assert.rejects(report(data), /independent|verified/i);
});

test('three latency samples report observed median/range/count and retain tiers/outages', async () => {
  const result = await report();
  assert.deepEqual(result.strata[0].latencyMs, { count: 3, missing: 0, median: 2000, min: 1000, max: 3000 });
  assert.equal(Object.hasOwn(result.strata[0].latencyMs, 'p95'), false);
  assert.equal(Object.hasOwn(result.strata[0].latencyMs, 'p99'), false);
  assert.equal(result.strata[0].outcomes.timeout, 1);
  assert.equal(result.strata[0].models.length, 3);
  assert.equal(result.strata[0].classes.length, 2);
});

test('imported reports remain reported evidence; rate changes are not a price engine', async () => {
  const data = fresh();
  data.manifest.provenance.kind = 'imported';
  for (const trace of data.traces) {
    trace.provenance.kind = 'imported'; trace.verification.provenance.kind = 'imported';
    for (const charge of trace.resourceCharges) {
      charge.provenance.kind = 'imported'; charge.provenance.reference += ':invoice-rate-2026-10-18';
      charge.amount = '7';
    }
  }
  const result = await report(data);
  assert.equal(result.strata[0].evidenceKind, 'imported');
  assert.equal(result.strata[0].costs[0].allInTotal, '21');
  assert.equal(result.localGradingExecuted, false);
  assert.equal(result.empiricalSavings, null);
  assert.ok(result.trajectories[0].resourceCharges[0].provenance.reference.includes('invoice-rate'));
});

test('paired outcomes keep synthetic and imported verifier results in separate evidence strata', async () => {
  const data = fresh(); data.manifest.provenance.kind = 'imported';
  const imported = copy(data.traces[0]); imported.runId = 'imported-one';
  imported.provenance.kind = 'imported'; imported.verification.provenance.kind = 'imported';
  imported.verification.verified = false;
  for (const charge of imported.resourceCharges) charge.provenance.kind = 'imported';
  data.traces.push(imported);
  const result = await report(data);
  const pairs = result.pairedOutcomes.filter(row => row.taskId === 'one');
  assert.equal(pairs.find(row => row.evidenceKind === 'synthetic')?.outcomes[0].verified, true);
  assert.equal(pairs.find(row => row.evidenceKind === 'imported')?.outcomes[0].verified, false);
  assert.equal(result.strata.find(row => row.evidenceKind === 'imported').verifiedResults, 0);
});

test('observed tool bytes are validated without becoming tokens or charges', async () => {
  const data = fresh(); data.traces[0].attempts[0].metrics.toolBytes = 77;
  const result = await report(data);
  assert.equal(result.trajectories[0].attempts[0].metrics.toolBytes, 77);
  assert.equal(result.trajectories[0].attempts[0].usage, null);
  assert.equal(cost(result).allInTotal, '10');
  data.traces[0].attempts[0].metrics.toolBytes = -1;
  await assert.rejects(report(data), /toolBytes/);
});

test('validation rejects invalid decimals, telemetry, references and inconsistent verification', async () => {
  const { validateRoutingTrace } = await api();
  for (const amount of fixture.invalidAmounts) {
    const trace = copy(fixture.traces[0]); trace.resourceCharges[0].amount = amount;
    assert.throws(() => validateRoutingTrace(trace), /amount/i, String(amount));
  }
  for (const mutate of [
    trace => { trace.attempts[0].durationMs = Infinity; },
    trace => { trace.attempts[0].metrics.contextBytes = -1; },
    trace => { trace.attempts[0].usage = {}; },
    trace => { trace.attempts[0].endedAt = '2020-01-01T00:00:00Z'; },
    trace => { trace.resourceCharges[0].includes = ['undeclared']; },
    trace => { trace.resourceCharges[0].reference = 'absent-attempt'; },
    trace => { trace.resourceCharges[0].currency = null; },
    trace => { trace.resourceCharges[0].provenance = null; },
    trace => { trace.attempts[1].id = 'a'; },
    trace => { trace.verification.grader.independent = false; },
    trace => { trace.verification.regressions[0].passed = false; },
    trace => { trace.version = 2; },
  ]) {
    const trace = copy(fixture.traces[0]); mutate(trace);
    assert.throws(() => validateRoutingTrace(trace));
  }
});

test('manifest boundaries and absent planned trajectories stay visible', async () => {
  const data = fresh(); data.traces.pop();
  const result = await report(data);
  assert.equal(result.cohort.complete, false);
  assert.equal(result.cohort.missing.length, 1);
  assert.equal(cost(result).allInTotal, null);
  data.traces[0].campaignId = 'other-campaign';
  await assert.rejects(report(data), /campaignId/i);
});

test('CLI consumes explicit JSONL/manifest from unrelated CWD and emits actionable errors', async () => {
  const cli = fileURLToPath(new URL('../scripts/benchmark-routing.mjs', import.meta.url));
  assert.ok(existsSync(cli), 'missing offline JSONL/manifest CLI');
  const dir = await mkdtemp(join(tmpdir(), 'routing-offline-'));
  try {
    const traces = join(dir, 'supplied.jsonl'); const manifest = join(dir, 'manifest.json');
    await writeFile(traces, fixture.traces.map(JSON.stringify).join('\n') + '\n');
    await writeFile(manifest, JSON.stringify(fixture.manifest));
    const run = args => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' });
    const ok = run(['--traces', traces, '--manifest', manifest]);
    assert.equal(ok.status, 0, ok.stderr);
    const result = JSON.parse(ok.stdout);
    assert.equal(cost(result).allInTotal, '10');
    assert.match(result.inputs.traces.sha256, /^[a-f0-9]{64}$/);
    assert.equal(result.mode, 'offline');
    for (const args of [[], ['--traces', traces], ['--unknown'], ['--traces', traces, '--traces', traces, '--manifest', manifest]]) {
      const bad = run(args); assert.equal(bad.status, 1); assert.match(bad.stderr, /usage|requires|duplicate|unknown/i);
      assert.equal(bad.stdout, '');
    }
    await writeFile(traces, '{}\nnot json\n');
    const malformed = run(['--traces', traces, '--manifest', manifest]);
    assert.equal(malformed.status, 1); assert.match(malformed.stderr, /supplied.jsonl:2.*JSON/i);
    await writeFile(traces, '{}\n');
    const invalid = run(['--traces', traces, '--manifest', manifest]);
    assert.equal(invalid.status, 1); assert.match(invalid.stderr, /supplied.jsonl:1.*version/i);
    const absent = run(['--traces', join(dir, 'absent.jsonl'), '--manifest', manifest]);
    assert.equal(absent.status, 1); assert.match(absent.stderr, /absent.jsonl.*ENOENT/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
