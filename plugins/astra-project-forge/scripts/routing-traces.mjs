import { createHash } from 'node:crypto';

// Offline v1 contract: IDs are local to a run; (campaignId, runId) is replay identity.
// Coverage declares every attempt/tool/handoff plus setup:trajectory and
// grading:verification. Charge includes[] names disjoint coverage IDs, including
// fees already covered by a provider total. Exclusions make all-in incomplete.
// Provenance kinds are observed, imported, synthetic, estimate; references are
// evidence pointers, not certifications. No grading or price estimation runs here.
const KINDS = ['observed', 'imported', 'synthetic', 'estimate'];
const SYSTEMS = ['api_money', 'product_credits', 'included_subscription'];
const SCOPES = ['attempt', 'grading', 'setup', 'handoff', 'tool'];
const OUTCOMES = ['success', 'failure', 'timeout', 'quota', 'error', 'cancelled', 'unknown'];
const COUNTS = ['toolCalls', 'duplicateToolCalls', 'toolBytes', 'coordinationBytes', 'contextBytes', 'contextExpansions', 'handoffs', 'retries'];
const TOKENS = ['inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const CONTROLS = ['sourceReference', 'taskInputsReference', 'promptReference', 'graderReference', 'policyReference', 'dependenciesReference', 'permissionsReference', 'toolSchemaReference', 'eligibilityReference', 'featureFlagsReference'];
const key = (...parts) => JSON.stringify(parts);
function need(condition, path, message) {
  if (!condition) throw new TypeError(`${path}: ${message}`);
}
function object(value, path) {
  need(value !== null && typeof value === 'object' && !Array.isArray(value), path, 'expected object');
}
function list(value, path) { need(Array.isArray(value), path, 'expected array'); }
function string(value, path) { need(typeof value === 'string' && value.trim().length > 0, path, 'expected nonempty string'); }
function nullableString(value, path) { if (value !== null) string(value, path); }
function choice(value, values, path) { need(values.includes(value), path, `expected ${values.join('|')}`); }
function count(value, path) { need(value === null || (Number.isSafeInteger(value) && value >= 0), path, 'expected nonnegative safe integer or null'); }
function boolean(value, path) { need(value === null || typeof value === 'boolean', path, 'expected boolean or null'); }
function unique(values, path) { need(new Set(values).size === values.length, path, 'duplicate identity'); }
function provenance(value, path) {
  object(value, path); choice(value.kind, KINDS, `${path}.kind`); string(value.reference, `${path}.reference`);
}
function json(value, path = 'value') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { need(Number.isFinite(value), path, 'non-finite number'); return; }
  need(typeof value === 'object', path, 'expected JSON data');
  need(Array.isArray(value) || [Object.prototype, null].includes(Object.getPrototypeOf(value)), path, 'expected JSON object');
  for (const [name, child] of Object.entries(value)) json(child, `${path}.${name}`);
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(name => `${JSON.stringify(name)}:${canonical(value[name])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const commitment = value => createHash('sha256').update(canonical(value)).digest('hex');
const STRATEGIES = ['sol_only', 'astra_only', 'sol_first_control', 'adaptive_evidence'];
const PILOT_MODELS = ['gpt-6.1-sol', 'gpt-6-astra'];
const FROZEN_PARTS = ['source', 'task', 'prompt', 'grader', 'artifacts'];
const VERIFICATION_FLOOR = ['mandatory_criteria', 'required_regressions', 'no_critical_false_success', 'no_new_critical_failure'];
const TASK_SLOTS = [
  ['routine-parser', 'routine-implementation'], ['routine-filter', 'routine-implementation'],
  ['debug-span', 'ordinary-debugging'], ['debug-nested-call', 'ordinary-debugging'],
  ['multi-manifest', 'multi-file-change'], ['multi-record', 'multi-file-change'],
  ['ambiguous-permission', 'ambiguous-failure'], ['ambiguous-eof', 'ambiguous-failure'],
  ['migration-unknown', 'state-migration'], ['migration-replay', 'state-migration'],
  ['architecture-gate', 'architecture'], ['architecture-layout', 'architecture'],
  ['long-package', 'long-agentic-work'], ['long-recovery', 'long-agentic-work'],
  ['risk-corrupt', 'risk-weighted-verification'], ['risk-counterevidence', 'risk-weighted-verification'],
];
function hash(value, path) { need(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), path, 'expected SHA-256 lowercase hex'); }
function stringList(value, path) {
  list(value, path); need(value.length > 0, path, 'expected nonempty array');
  value.forEach(item => string(item, path)); unique(value, path);
}
function controlReferences(value, path, nullable = false) {
  object(value, path);
  need(Object.keys(value).length === CONTROLS.length && Object.keys(value).every(name => CONTROLS.includes(name)), path, 'expected exact common control keys');
  for (const name of CONTROLS) (nullable ? nullableString : string)(value[name], `${path}.${name}`);
}

/** Validate supplied commitments only, never external artifacts or approval truth.
 * Synthetic contracts undergo the same checks. Acceptance grants no execution.
 */
export function validateRoutingCampaign(value) {
  json(value); object(value, 'campaign'); need(value.version === 1, 'campaign.version', 'expected 1');
  string(value.campaignId, 'campaign.campaignId'); provenance(value.provenance, 'campaign.provenance');
  choice(value.status, ['draft', 'frozen'], 'campaign.status');
  need(canonical(value.strategies) === canonical(STRATEGIES), 'campaign.strategies', 'expected four ordered strategies');
  need(canonical(value.repetitions) === '[1,2,3]', 'campaign.repetitions', 'expected three matched repetitions');
  need(Number.isInteger(value.schedulingSeed) && value.schedulingSeed >= 0 && value.schedulingSeed <= 0xffffffff, 'campaign.schedulingSeed', 'expected uint32 scheduling seed');
  need(canonical(value.cacheStratumByRepetition) === '["cold","warm","cold"]', 'campaign.cacheStratumByRepetition', 'expected paired cold/warm/cold assignments');
  controlReferences(value.controls, 'campaign.controls');
  list(value.arms, 'campaign.arms'); need(value.arms.length === 4, 'campaign.arms', 'expected four arms');
  for (const [index, arm] of value.arms.entries()) {
    object(arm, 'campaign.arms');
    need(arm.strategy === STRATEGIES[index], 'campaign.arms.strategy', 'strategy_rule: expected ordered arm identity');
    controlReferences(arm.controls, 'campaign.arms.controls');
    need(canonical(arm.controls) === canonical(value.controls), 'campaign.arms.controls', 'shared_controls: all arms require identical capabilities and controls');
    need(canonical(arm.verificationFloor) === canonical(VERIFICATION_FLOOR), 'campaign.arms.verificationFloor', 'verification_floor: mandatory checks cannot be weakened');
    const initial = ['sol', 'astra', 'sol', 'policy'][index];
    const escalation = ['never', 'never', 'first_failed_verification_or_unchanged_failed_strategy', 'evidence_based'][index];
    need(arm.initialModel === initial && arm.escalation === escalation, 'campaign.arms', 'strategy_rule: control trigger is isolated from production policy');
  }
  const missing = [];
  const frozenHash = (item, path) => {
    if (item == null) missing.push(`missing_freeze:${path}`); else hash(item, path);
  };
  const frozenManifest = (item, path) => {
    if (item == null) { missing.push(`missing_freeze:${path}`); return; }
    object(item, path); string(item.reference, `${path}.reference`); hash(item.sha256, `${path}.sha256`);
  };
  const review = (reference, name) => {
    if (reference == null) missing.push(`missing_${name}`); else string(reference, `campaign.${name}`);
  };
  if (value.status !== 'frozen') missing.push('missing_freeze:status');
  frozenHash(value.freezeCommitment, 'freezeCommitment');
  object(value.policy, 'campaign.policy'); frozenManifest(value.policy.manifest, 'policy.manifest');
  need(value.policy.tunedOnEvaluation === false, 'campaign.policy', 'evaluation_tuning_forbidden');
  object(value.reviews, 'campaign.reviews');
  review(value.reviews.readinessReference, 'readiness_review'); review(value.reviews.spendingReference, 'spending_review');
  review(value.reviews.graderIndependenceReference, 'independent_grader_review');
  list(value.tasks, 'campaign.tasks'); need(value.tasks.length === 16, 'campaign.tasks', 'evaluation_slots: expected sixteen tasks');
  const identities = []; const contents = []; const splits = new Set();
  for (const task of value.tasks) {
    object(task, 'campaign.tasks'); string(task.taskId, 'campaign.tasks.taskId');
    need(TASK_SLOTS.some(([id, category]) => id === task.taskId && category === task.category), 'campaign.tasks', 'evaluation_slots: unknown task/category');
    choice(task.split, ['held_out', 'out_of_domain'], 'campaign.tasks.split'); splits.add(task.split);
    choice(task.criticality, ['ordinary', 'critical'], 'campaign.tasks.criticality');
    stringList(task.requiredChecks, 'campaign.tasks.requiredChecks');
    frozenHash(task.contentIdentity, `tasks.${task.taskId}.contentIdentity`);
    identities.push(task.taskId); if (task.contentIdentity != null) contents.push(task.contentIdentity);
    if (task.frozen == null) missing.push(`missing_freeze:tasks.${task.taskId}.frozen`);
    else {
      object(task.frozen, 'campaign.tasks.frozen');
      for (const name of FROZEN_PARTS) frozenManifest(task.frozen[name], `tasks.${task.taskId}.frozen.${name}`);
    }
    if (task.grader == null) { missing.push(`missing_independent_grader:${task.taskId}`); continue; }
    object(task.grader, 'campaign.tasks.grader');
    choice(task.grader.kind, ['executable', 'blinded_rubric'], 'campaign.tasks.grader.kind');
    need(task.grader.independent === true, 'campaign.tasks.grader.independent', 'independent grader required');
    review(task.grader.hiddenReviewReference, `hidden_grader_review:${task.taskId}`);
    if (task.category === 'architecture') need(task.grader.kind === 'blinded_rubric', 'campaign.tasks.grader.kind', 'architecture requires blinded rubric');
    if (task.grader.kind === 'blinded_rubric') {
      review(task.grader.calibrationReviewReference, `rubric_calibration_review:${task.taskId}`);
      review(task.grader.humanAgreementReviewReference, `human_agreement_review:${task.taskId}`);
    }
  }
  need(splits.size === 2, 'campaign.tasks.split', 'evaluation_split: retain held-out and out-of-domain tasks');
  list(value.calibrationTasks, 'campaign.calibrationTasks'); need(value.calibrationTasks.length > 0, 'campaign.calibrationTasks', 'separate calibration tasks required');
  for (const task of value.calibrationTasks) {
    object(task, 'campaign.calibrationTasks'); string(task.taskId, 'campaign.calibrationTasks.taskId');
    frozenHash(task.contentIdentity, `calibrationTasks.${task.taskId}.contentIdentity`);
    frozenManifest(task.manifest, `calibrationTasks.${task.taskId}.manifest`);
    identities.push(task.taskId); if (task.contentIdentity != null) contents.push(task.contentIdentity);
  }
  need(new Set(identities).size === identities.length && new Set(contents).size === contents.length, 'campaign.tasks', 'task_identity_or_content_overlap');
  need(missing.length === 0, 'campaign readiness', missing.join('; '));
  const { freezeCommitment, ...content } = value;
  need(commitment(content) === freezeCommitment, 'campaign.freezeCommitment', 'manifest_drift: supplied frozen contract changed');
  return structuredClone(value);
}

/** Proposed assignments only. SHA-256 counter draws randomize arm order within
 * each paired block; neither this seed nor a commitment controls model output.
 */
export function buildRoutingSchedule(value) {
  const campaign = validateRoutingCampaign(value);
  let draw = 0;
  const assignments = [];
  for (const task of campaign.tasks) for (const repetition of campaign.repetitions) {
    const strategies = [...campaign.strategies];
    for (let index = strategies.length - 1; index > 0; index--) {
      const number = Number.parseInt(commitment([campaign.schedulingSeed, draw++]).slice(0, 8), 16);
      const position = number % (index + 1);
      [strategies[index], strategies[position]] = [strategies[position], strategies[index]];
    }
    for (const strategy of strategies) {
      const assignedCacheStratum = campaign.cacheStratumByRepetition[repetition - 1];
      assignments.push({
        mode: 'offline', executionAuthorized: false, executionStatus: 'not_attempted',
        campaignId: campaign.campaignId, taskId: task.taskId, repetition, strategy, assignedCacheStratum,
        binding: { campaignCommitment: campaign.freezeCommitment, taskCommitment: commitment(task), assignedCacheStratum,
          manifests: Object.fromEntries(FROZEN_PARTS.map(name => [name, task.frozen[name].sha256])),
          requiredChecks: [...task.requiredChecks], controls: structuredClone(campaign.controls) },
      });
    }
  }
  return assignments;
}

function validateCampaignBinding(value) {
  const path = 'trace.campaignBinding'; object(value, path);
  const names = ['campaignCommitment', 'taskCommitment', 'assignedCacheStratum', 'manifests', 'requiredChecks', 'controls'];
  need(Object.keys(value).length === names.length && Object.keys(value).every(name => names.includes(name)), path, 'expected exact binding fields');
  hash(value.campaignCommitment, `${path}.campaignCommitment`); hash(value.taskCommitment, `${path}.taskCommitment`);
  choice(value.assignedCacheStratum, ['cold', 'warm'], `${path}.assignedCacheStratum`);
  object(value.manifests, `${path}.manifests`);
  need(Object.keys(value.manifests).length === FROZEN_PARTS.length && Object.keys(value.manifests).every(name => FROZEN_PARTS.includes(name)), `${path}.manifests`, 'expected exact frozen manifest keys');
  for (const name of FROZEN_PARTS) if (value.manifests[name] !== null) hash(value.manifests[name], `${path}.manifests.${name}`);
  if (value.requiredChecks !== null) stringList(value.requiredChecks, `${path}.requiredChecks`);
  controlReferences(value.controls, `${path}.controls`, true);
}
function accounting(value, path) {
  choice(value.accountingSystem, SYSTEMS, `${path}.accountingSystem`);
  if (value.accountingSystem === 'api_money') {
    need(typeof value.currency === 'string' && /^[A-Z]{3}$/.test(value.currency), `${path}.currency`, 'API money requires stated currency code');
  } else need(value.currency === null, `${path}.currency`, 'credits/subscription use null currency; no money conversion');
}
function decimal(value, path) {
  need(typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value), path, 'amount must be a nonnegative base-10 decimal string or null');
  const [whole, fraction = ''] = value.split('.');
  return { coefficient: BigInt(whole + fraction), scale: fraction.length };
}
function formatted(coefficient, scale) {
  const digits = coefficient.toString().padStart(scale + 1, '0');
  if (!scale) return digits;
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/0+$/, '').replace(/\.$/, '');
}
function sum(amounts) {
  const values = amounts.map(value => decimal(value, 'amount'));
  const scale = values.reduce((max, value) => Math.max(max, value.scale), 0);
  return formatted(values.reduce((total, value) => total + value.coefficient * 10n ** BigInt(scale - value.scale), 0n), scale);
}
function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }
function ratio(amount, results) {
  const value = decimal(amount, 'amount');
  let numerator = value.coefficient;
  let denominator = BigInt(results) * 10n ** BigInt(value.scale);
  const divisor = gcd(numerator, denominator);
  numerator /= divisor; denominator /= divisor;
  let remaining = denominator; let twos = 0; let fives = 0;
  while (remaining % 2n === 0n) { remaining /= 2n; twos++; }
  while (remaining % 5n === 0n) { remaining /= 5n; fives++; }
  if (remaining === 1n) {
    const scale = Math.max(twos, fives);
    const exactDecimal = formatted(numerator * (10n ** BigInt(scale) / denominator), scale);
    return { numerator: amount, denominator: String(results), exactDecimal, display: exactDecimal, rounding: null };
  }
  const scaled = numerator * 1000000n;
  const rounded = scaled / denominator + ((scaled % denominator) * 2n >= denominator ? 1n : 0n);
  const digits = rounded.toString().padStart(7, '0');
  return {
    numerator: amount, denominator: String(results), exactDecimal: null,
    display: `${digits.slice(0, -6)}.${digits.slice(-6)}`,
    rounding: { mode: 'half_up', decimalPlaces: 6 },
  };
}
function expectedResources(trace) {
  return [
    { scope: 'setup', reference: 'trajectory' }, { scope: 'grading', reference: 'verification' },
    ...trace.attempts.flatMap(attempt => ['attempt', 'tool', 'handoff'].map(scope => ({ scope, reference: attempt.id }))),
  ];
}
function resource(value, expected, path) {
  object(value, path); choice(value.scope, SCOPES, `${path}.scope`); string(value.reference, `${path}.reference`);
  need(expected.has(key(value.scope, value.reference)), path, `unknown ${value.scope} reference ${value.reference}`);
}
function checks(value, path) {
  list(value, path);
  for (const [index, item] of value.entries()) {
    object(item, `${path}[${index}]`); string(item.id, `${path}[${index}].id`); boolean(item.passed, `${path}[${index}].passed`);
  }
  unique(value.map(item => item.id), path);
}
function verificationComplete(value) {
  return value.grader?.independent === true && value.grader.kind !== 'self_report'
    && value.mandatoryCriteria.length > 0 && value.mandatoryCriteria.every(item => item.passed === true)
    && value.regressions.length > 0 && value.regressions.every(item => item.passed === true)
    && value.criticalFailure === false && value.falseSuccess === false;
}

/** Validate and return a detached TraceV1. Unknown JSON fields are preserved. */
export function validateRoutingTrace(value) {
  json(value); object(value, 'trace'); need(value.version === 1, 'trace.version', 'expected 1');
  if (Object.hasOwn(value, 'campaignBinding')) validateCampaignBinding(value.campaignBinding);
  for (const name of ['campaignId', 'taskId', 'strategy', 'runId']) string(value[name], `trace.${name}`);
  count(value.repetition, 'trace.repetition'); need(value.repetition > 0, 'trace.repetition', 'expected positive integer');
  provenance(value.provenance, 'trace.provenance');
  list(value.attempts, 'trace.attempts'); need(value.attempts.length > 0, 'trace.attempts', 'at least one attempt required');
  for (const [index, attempt] of value.attempts.entries()) {
    const path = `trace.attempts[${index}]`; object(attempt, path); string(attempt.id, `${path}.id`);
    for (const name of ['requestedModel', 'observedModel', 'effort', 'tier', 'providerFingerprint', 'contextReference']) nullableString(attempt[name], `${path}.${name}`);
    choice(attempt.cacheState, ['cold', 'warm', 'unknown'], `${path}.cacheState`);
    count(attempt.seed, `${path}.seed`); count(attempt.durationMs, `${path}.durationMs`);
    for (const name of ['startedAt', 'endedAt']) {
      const stamp = attempt[name];
      need(stamp === null || (typeof stamp === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(stamp) && Number.isFinite(Date.parse(stamp))), `${path}.${name}`, 'expected ISO timestamp with timezone or null');
    }
    if (attempt.startedAt !== null && attempt.endedAt !== null) {
      const elapsed = Date.parse(attempt.endedAt) - Date.parse(attempt.startedAt);
      need(elapsed >= 0, path, 'endedAt precedes startedAt');
      need(attempt.durationMs === null || elapsed === attempt.durationMs, `${path}.durationMs`, 'inconsistent with timestamps');
    }
    choice(attempt.outcome, OUTCOMES, `${path}.outcome`);
    object(attempt.metrics, `${path}.metrics`);
    for (const name of COUNTS) count(attempt.metrics[name], `${path}.metrics.${name}`);
    boolean(attempt.metrics.recoveryCorrect, `${path}.metrics.recoveryCorrect`);
    if (attempt.metrics.toolCalls !== null && attempt.metrics.duplicateToolCalls !== null) {
      need(attempt.metrics.duplicateToolCalls <= attempt.metrics.toolCalls, `${path}.metrics`, 'duplicates exceed tool calls');
    }
    list(attempt.artifacts, `${path}.artifacts`);
    for (const artifact of attempt.artifacts) {
      object(artifact, `${path}.artifacts`); string(artifact.reference, `${path}.artifacts.reference`); nullableString(artifact.hash, `${path}.artifacts.hash`);
    }
    if (attempt.usage !== null) {
      const usage = attempt.usage; object(usage, `${path}.usage`); string(usage.sourceReference, `${path}.usage.sourceReference`);
      for (const name of TOKENS) count(usage[name], `${path}.usage.${name}`);
      object(usage.subsetOf, `${path}.usage.subsetOf`);
      for (const [child, parent] of [['reasoningTokens', 'outputTokens'], ['cacheReadTokens', 'inputTokens'], ['cacheWriteTokens', 'inputTokens']]) {
        need(usage.subsetOf[child] === null || usage.subsetOf[child] === parent, `${path}.usage.subsetOf.${child}`, `expected ${parent} or null`);
        if (usage.subsetOf[child] !== null && usage[child] !== null && usage[parent] !== null) {
          need(usage[child] <= usage[parent], `${path}.usage.${child}`, `subset exceeds ${parent}`);
        }
      }
    }
  }
  unique(value.attempts.map(attempt => attempt.id), 'trace.attempts');
  const verification = value.verification; object(verification, 'trace.verification');
  provenance(verification.provenance, 'trace.verification.provenance');
  need(verification.provenance.kind === value.provenance.kind, 'trace.verification.provenance.kind', 'must match trajectory evidence kind');
  if (verification.grader !== null) {
    object(verification.grader, 'trace.verification.grader'); string(verification.grader.reference, 'trace.verification.grader.reference');
    need(typeof verification.grader.independent === 'boolean', 'trace.verification.grader.independent', 'expected boolean');
    choice(verification.grader.kind, ['executable', 'blinded_rubric', 'self_report'], 'trace.verification.grader.kind');
  }
  checks(verification.mandatoryCriteria, 'trace.verification.mandatoryCriteria'); checks(verification.regressions, 'trace.verification.regressions');
  for (const name of ['criticalFailure', 'falseSuccess', 'verified']) boolean(verification[name], `trace.verification.${name}`);
  need(verification.verified !== true || verificationComplete(verification), 'trace.verification.verified', 'true requires independent grader, all mandatory/regression passes and no critical/false success');

  const expected = new Set(expectedResources(value).map(item => key(item.scope, item.reference)));
  const coverage = value.chargeCoverage; object(coverage, 'trace.chargeCoverage');
  list(coverage.required, 'trace.chargeCoverage.required'); list(coverage.exclusions, 'trace.chargeCoverage.exclusions');
  for (const item of coverage.required) {
    resource(item, expected, 'trace.chargeCoverage.required'); string(item.id, 'trace.chargeCoverage.required.id'); accounting(item, 'trace.chargeCoverage.required');
  }
  unique(coverage.required.map(item => item.id), 'trace.chargeCoverage.required');
  const declarations = new Map(coverage.required.map(item => [item.id, item]));
  const requiredScopes = new Set(coverage.required.map(item => key(item.scope, item.reference)));
  for (const item of coverage.exclusions) {
    resource(item, expected, 'trace.chargeCoverage.exclusions'); string(item.reason, 'trace.chargeCoverage.exclusions.reason');
    need(!requiredScopes.has(key(item.scope, item.reference)), 'trace.chargeCoverage.exclusions', 'resource is both required and excluded');
  }
  unique(coverage.exclusions.map(item => key(item.scope, item.reference)), 'trace.chargeCoverage.exclusions');
  list(value.resourceCharges, 'trace.resourceCharges');
  const included = new Set();
  for (const [index, charge] of value.resourceCharges.entries()) {
    const path = `trace.resourceCharges[${index}]`; resource(charge, expected, path); string(charge.id, `${path}.id`); accounting(charge, path);
    if (charge.amount !== null) decimal(charge.amount, `${path}.amount`);
    provenance(charge.provenance, `${path}.provenance`);
    need([value.provenance.kind, 'estimate'].includes(charge.provenance.kind), `${path}.provenance.kind`, 'must match trajectory kind or be a separately reported estimate');
    list(charge.includes, `${path}.includes`); need(charge.includes.length > 0, `${path}.includes`, 'declare included resource IDs');
    for (const id of charge.includes) {
      string(id, `${path}.includes`); const declaration = declarations.get(id);
      need(declaration, `${path}.includes`, `undeclared resource ${id}`);
      need(declaration.accountingSystem === charge.accountingSystem && declaration.currency === charge.currency, path, `inconsistent accounting group for ${id}`);
      const identity = key(charge.provenance.kind, id);
      need(!included.has(identity), path, `overlap of resource ${id}`); included.add(identity);
    }
  }
  unique(value.resourceCharges.map(charge => charge.id), 'trace.resourceCharges');
  return structuredClone(value);
}

function validateManifest(value) {
  json(value); object(value, 'manifest'); need(value.version === 1, 'manifest.version', 'expected 1');
  string(value.campaignId, 'manifest.campaignId'); provenance(value.provenance, 'manifest.provenance');
  list(value.tasks, 'manifest.tasks'); need(value.tasks.length > 0, 'manifest.tasks', 'at least one task required');
  for (const task of value.tasks) {
    object(task, 'manifest.tasks'); string(task.taskId, 'manifest.tasks.taskId'); string(task.category, 'manifest.tasks.category');
    choice(task.criticality, ['ordinary', 'critical'], 'manifest.tasks.criticality');
  }
  unique(value.tasks.map(task => task.taskId), 'manifest.tasks');
  list(value.strategies, 'manifest.strategies'); need(value.strategies.length > 0, 'manifest.strategies', 'at least one strategy required');
  for (const strategy of value.strategies) string(strategy, 'manifest.strategies'); unique(value.strategies, 'manifest.strategies');
  list(value.repetitions, 'manifest.repetitions'); need(value.repetitions.length > 0, 'manifest.repetitions', 'at least one repetition required');
  for (const repetition of value.repetitions) need(Number.isSafeInteger(repetition) && repetition > 0, 'manifest.repetitions', 'expected positive integers');
  unique(value.repetitions, 'manifest.repetitions'); object(value.controls, 'manifest.controls');
  for (const name of CONTROLS) string(value.controls[name], `manifest.controls.${name}`);
  if (Object.hasOwn(value, 'routingCampaign')) {
    const campaign = validateRoutingCampaign(value.routingCampaign);
    const tasks = values => values.map(({ taskId, category, criticality }) => ({ taskId, category, criticality }))
      .sort((a, b) => a.taskId.localeCompare(b.taskId, 'en'));
    need(campaign.campaignId === value.campaignId && campaign.provenance.kind === value.provenance.kind
      && canonical(tasks(campaign.tasks)) === canonical(tasks(value.tasks))
      && canonical(campaign.strategies) === canonical(value.strategies)
      && canonical(campaign.repetitions) === canonical(value.repetitions)
      && canonical(campaign.controls) === canonical(value.controls), 'manifest.routingCampaign', 'campaign_manifest_mismatch');
  }
  return structuredClone(value);
}
function latency(attempts) {
  const samples = attempts.map(attempt => attempt.durationMs).filter(value => value !== null).sort((a, b) => a - b);
  const middle = Math.floor(samples.length / 2);
  const median = samples.length === 0 ? null : samples.length % 2 ? samples[middle] : samples[middle - 1] / 2 + samples[middle] / 2;
  return { count: samples.length, missing: attempts.length - samples.length, median, min: samples[0] ?? null, max: samples.at(-1) ?? null };
}
function groupBy(values, identity) {
  const groups = new Map();
  for (const value of values) {
    const id = identity(value); if (!groups.has(id)) groups.set(id, []); groups.get(id).push(value);
  }
  return [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, rows]) => rows);
}
const blockKey = trace => key(trace.taskId, trace.repetition, trace.strategy);

function campaignProtocol(traces, campaign, schedule, cohort) {
  const issues = [];
  const issue = (trace, reason, field, severity = 'unknown') => issues.push({ runId: trace.runId, reason, field, severity });
  let observedSwitches = 0;
  for (const trace of traces) {
    const expected = schedule.get(blockKey(trace)).binding;
    const binding = trace.campaignBinding;
    if (!binding) issue(trace, 'binding_missing', 'campaignBinding');
    else {
      for (const name of ['campaignCommitment', 'taskCommitment', 'assignedCacheStratum', 'requiredChecks']) {
        if (binding[name] === null) issue(trace, 'missing_observation', name);
        else if (canonical(binding[name]) !== canonical(expected[name])) issue(trace, 'binding_drift', name, 'violation');
      }
      for (const group of ['manifests', 'controls']) for (const [name, value] of Object.entries(expected[group])) {
        if (binding[group][name] === null) issue(trace, 'missing_observation', `${group}.${name}`);
        else if (binding[group][name] !== value) issue(trace, 'binding_drift', `${group}.${name}`, 'violation');
      }
    }
    const task = campaign.tasks.find(task => task.taskId === trace.taskId);
    const grader = trace.verification.grader;
    if (!grader) issue(trace, 'missing_observation', 'verification.grader');
    else if (grader.reference !== task.frozen.grader.reference || grader.kind !== task.grader.kind || !grader.independent) {
      issue(trace, 'grader_drift', 'verification.grader', 'violation');
    }
    for (const id of task.requiredChecks) {
      const checks = [...trace.verification.mandatoryCriteria, ...trace.verification.regressions].filter(check => check.id === id);
      if (!checks.length) issue(trace, 'required_check_missing', id);
      else if (checks.some(check => check.passed === false)) issue(trace, 'required_check_failed', id, 'failure');
      else if (checks.some(check => check.passed === null)) issue(trace, 'missing_observation', id);
    }
    if (trace.verification.verified === null) issue(trace, 'verification_unknown', 'verification.verified');
    for (const [index, attempt] of trace.attempts.entries()) {
      if (attempt.requestedModel !== null && !PILOT_MODELS.includes(attempt.requestedModel)) {
        issue(trace, 'model_deviation', `attempts.${attempt.id}.requestedModel`, 'violation');
      }
      if (attempt.observedModel === null) issue(trace, 'model_unobserved', `attempts.${attempt.id}.observedModel`);
      else {
        const fixedModel = trace.strategy === 'astra_only' ? 'gpt-6-astra'
          : trace.strategy === 'sol_only' || trace.strategy === 'sol_first_control' && index === 0 ? 'gpt-6.1-sol' : null;
        if (!PILOT_MODELS.includes(attempt.observedModel) || fixedModel && attempt.observedModel !== fixedModel
          || attempt.requestedModel !== null && attempt.requestedModel !== attempt.observedModel) {
          issue(trace, 'model_deviation', `attempts.${attempt.id}.observedModel`, 'violation');
        }
        const previous = trace.attempts[index - 1];
        if (PILOT_MODELS.includes(previous?.observedModel) && PILOT_MODELS.includes(attempt.observedModel)
          && previous.observedModel !== attempt.observedModel && attempt.requestedModel === attempt.observedModel) observedSwitches++;
      }
      if (attempt.outcome !== 'success') issue(trace, 'outcome_not_success', `attempts.${attempt.id}.outcome`,
        index < trace.attempts.length - 1 ? 'operational' : 'unknown');
      if (attempt.metrics.recoveryCorrect === false) issue(trace, 'recovery_failed', `attempts.${attempt.id}.metrics.recoveryCorrect`, 'failure');
    }
    if (task.taskId === 'long-recovery' && trace.attempts.at(-1).metrics.recoveryCorrect === null) {
      issue(trace, 'recovery_unobserved', 'attempts.final.metrics.recoveryCorrect');
    }
  }
  const failed = trace => trace.verification.verified === false || trace.verification.criticalFailure === true
    || trace.verification.falseSuccess === true || trace.verification.regressions.some(check => check.passed === false)
    || trace.verification.mandatoryCriteria.some(check => check.passed === false)
    || trace.attempts.some(attempt => attempt.metrics.recoveryCorrect === false);
  const classes = [...new Set(campaign.tasks.map(task => task.category))].map(category => {
    const taskIds = new Set(campaign.tasks.filter(task => task.category === category).map(task => task.taskId));
    const rows = traces.filter(trace => taskIds.has(trace.taskId));
    return { category, expectedBlocks: taskIds.size * 12, observedBlocks: new Set(rows.map(blockKey)).size,
      missingBlocks: cohort.missing.filter(block => taskIds.has(block.taskId)), failures: rows.filter(failed).length };
  });
  const cacheStrata = ['cold', 'warm'].map(assignedCacheStratum => {
    const assigned = [...schedule.values()].filter(row => row.assignedCacheStratum === assignedCacheStratum);
    const blocks = new Set(assigned.map(blockKey));
    const rows = traces.filter(trace => blocks.has(blockKey(trace)));
    const charges = rows.flatMap(trace => trace.resourceCharges);
    const costs = groupBy(charges, charge => key(charge.accountingSystem, charge.currency, charge.provenance.kind)).map(group => ({
      accountingSystem: group[0].accountingSystem, currency: group[0].currency, evidenceKind: group[0].provenance.kind,
      knownSubtotal: group.some(charge => charge.amount !== null) ? sum(group.filter(charge => charge.amount !== null).map(charge => charge.amount)) : null,
    }));
    return { assignedCacheStratum, expectedBlocks: assigned.length, observedBlocks: new Set(rows.map(blockKey)).size,
      missingBlocks: cohort.missing.filter(block => blocks.has(blockKey(block))), runIds: rows.map(trace => trace.runId),
      failures: rows.filter(failed).length, costs };
  });
  const status = issues.some(item => item.severity === 'violation') ? 'violation'
    : traces.some(failed) || issues.some(item => item.severity === 'failure') ? 'failed'
      : !cohort.complete || !traces.length || issues.some(item => item.severity === 'unknown') ? 'inconclusive' : 'consistent_observations';
  return { status, issues, observedSwitches, classes, cacheStrata,
    missingTelemetry: { attemptsWithoutUsage: traces.flatMap(trace => trace.attempts).filter(attempt => attempt.usage === null).length },
    ordinaryNonInferiority: 'unresolved_pending_preregistration', sampleAdequacy: 'inconclusive',
    externalReadinessVerified: false, executionAuthorized: false };
}

/** Aggregate supplied evidence only. Cost/verified denominators count each
 * task/repetition/strategy once; reruns add costs, never extra completions.
 * Manifest controls are declarations, not proof of paired experimental validity.
 */
export function summarizeRoutingTraces(values, suppliedManifest) {
  const manifest = validateManifest(suppliedManifest); list(values, 'traces');
  const campaign = manifest.routingCampaign;
  const schedule = campaign ? new Map(buildRoutingSchedule(campaign).map(assignment => [blockKey(assignment), assignment])) : null;
  const identities = new Map(); let duplicateRecords = 0;
  for (const value of values) {
    const trace = validateRoutingTrace(value);
    need(trace.campaignId === manifest.campaignId, 'trace.campaignId', 'does not match manifest');
    need(manifest.tasks.some(task => task.taskId === trace.taskId), 'trace.taskId', 'not declared by manifest');
    need(manifest.strategies.includes(trace.strategy), 'trace.strategy', 'not declared by manifest');
    need(manifest.repetitions.includes(trace.repetition), 'trace.repetition', 'not declared by manifest');
    need(manifest.provenance.kind !== 'synthetic' || trace.provenance.kind === 'synthetic', 'trace.provenance.kind', 'synthetic manifest cannot label real evidence');
    const id = key(trace.campaignId, trace.runId); const previous = identities.get(id);
    need(!previous || canonical(previous) === canonical(trace), 'traces', `conflicting replay ${trace.runId}`);
    if (previous) duplicateRecords++; else identities.set(id, trace);
  }
  const trajectories = [...identities.values()].sort((a, b) => a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0);
  const planned = manifest.tasks.flatMap(task => manifest.repetitions.flatMap(repetition => manifest.strategies.map(strategy => ({ taskId: task.taskId, repetition, strategy }))));
  const evidenceKinds = [...new Set([manifest.provenance.kind, ...trajectories.map(trace => trace.provenance.kind)])].sort();
  const assessments = evidenceKinds.map(evidenceKind => {
    const traces = trajectories.filter(trace => trace.provenance.kind === evidenceKind);
    const observed = new Set(traces.map(blockKey));
    const missing = planned.filter(block => !observed.has(blockKey(block)));
    const vetoes = traces.flatMap(trace => {
      const result = [];
      if (trace.verification.criticalFailure === true) result.push('critical_failure');
      if (trace.verification.falseSuccess === true) result.push('false_success');
      if (trace.verification.regressions.some(item => item.passed === false)) result.push('regression_failure');
      return result.map(reason => ({ runId: trace.runId, reason }));
    });
    const cohort = { expectedBlocks: planned.length, observedBlocks: observed.size, complete: missing.length === 0, missing };
    const protocol = campaign ? campaignProtocol(traces, campaign, schedule, cohort) : null;
    return {
      evidenceKind,
      cohort,
      ...(protocol ? { protocol } : {}),
      quality: {
        veto: vetoes.length > 0, vetoes,
        floorSatisfied: missing.length === 0 && traces.length > 0 && traces.every(trace => trace.verification.verified === true && verificationComplete(trace.verification))
          && (!protocol || protocol.status === 'consistent_observations'),
        efficiencyClaimAllowed: false,
        reason: 'offline_evidence_reporting_only_no_comparative_inference',
      },
    };
  });
  // Mixed evidence has no combined success assessment; single-kind aliases stay.
  const summary = assessments.length === 1 ? assessments[0] : null;
  const strata = groupBy(trajectories, trace => key(trace.provenance.kind, trace.strategy)).map(traces => {
    const evidenceKind = traces[0].provenance.kind; const strategy = traces[0].strategy;
    const { cohort, quality, protocol } = assessments.find(assessment => assessment.evidenceKind === evidenceKind);
    const attempts = traces.flatMap(trace => trace.attempts);
    const verifiedResults = new Set(traces.filter(trace => trace.verification.verified === true).map(blockKey)).size;
    const missingBlocks = cohort.missing.filter(block => block.strategy === strategy);
    const coverageIssues = [];
    for (const trace of traces) {
      for (const item of expectedResources(trace)) {
        const declared = trace.chargeCoverage.required.some(row => row.scope === item.scope && row.reference === item.reference);
        if (!declared) {
          const exclusion = trace.chargeCoverage.exclusions.find(row => row.scope === item.scope && row.reference === item.reference);
          coverageIssues.push({ runId: trace.runId, ...item, reason: exclusion ? 'excluded_resource' : 'missing_coverage_declaration', detail: exclusion?.reason ?? null });
        }
      }
    }
    const required = traces.flatMap(trace => trace.chargeCoverage.required.map(resource => ({ ...resource, runId: trace.runId })));
    const charges = traces.flatMap(trace => trace.resourceCharges.map(charge => ({ ...charge, runId: trace.runId })));
    const declarationsComplete = coverageIssues.length === 0;
    const groupDeclarations = [...required.map(row => ({ ...row, evidenceKind })), ...charges.map(row => ({ ...row, evidenceKind: row.provenance.kind }))];
    const costs = groupBy(groupDeclarations, row => key(row.accountingSystem, row.currency, row.evidenceKind)).map(rows => {
      const first = rows[0];
      const sameGroup = row => row.accountingSystem === first.accountingSystem && row.currency === first.currency;
      const includedCharges = charges.filter(row => sameGroup(row) && row.provenance.kind === first.evidenceKind);
      const requiredResources = required.filter(sameGroup);
      const missingResources = requiredResources.filter(resource => !includedCharges.some(charge => charge.runId === resource.runId && charge.amount !== null && charge.includes.includes(resource.id)))
        .map(resource => ({ runId: resource.runId, resourceId: resource.id, scope: resource.scope, reference: resource.reference }));
      coverageIssues.push(...missingResources.map(resource => ({
        ...resource, accountingSystem: first.accountingSystem, currency: first.currency, evidenceKind: first.evidenceKind,
        reason: includedCharges.some(charge => charge.runId === resource.runId && charge.includes.includes(resource.resourceId)) ? 'unknown_charge_amount' : 'missing_charge',
      })));
      const coverageComplete = missingResources.length === 0 && declarationsComplete && missingBlocks.length === 0;
      const knownAmounts = includedCharges.filter(charge => charge.amount !== null).map(charge => charge.amount);
      const knownSubtotal = knownAmounts.length ? sum(knownAmounts) : null;
      const allInTotal = coverageComplete ? knownSubtotal : null;
      const unitCostReason = quality.veto ? 'quality_veto' : protocol && protocol.status !== 'consistent_observations' ? 'protocol_not_satisfied'
        : !coverageComplete ? 'incomplete_cost_coverage' : verifiedResults === 0 ? 'zero_verified_results' : null;
      return {
        accountingSystem: first.accountingSystem, currency: first.currency, evidenceKind: first.evidenceKind,
        knownSubtotal, allInTotal, coverageComplete, missingResources,
        costPerVerifiedResult: unitCostReason === null ? ratio(allInTotal, verifiedResults) : null, unitCostReason,
        chargeIds: includedCharges.map(charge => ({ runId: charge.runId, id: charge.id })),
      };
    });
    const models = groupBy(attempts, attempt => key(attempt.requestedModel, attempt.observedModel, attempt.effort, attempt.tier, attempt.cacheState)).map(rows => ({
      requestedModel: rows[0].requestedModel, observedModel: rows[0].observedModel, effort: rows[0].effort, tier: rows[0].tier, cacheState: rows[0].cacheState,
      attemptCount: rows.length, latencyMs: latency(rows),
    }));
    const classes = groupBy(traces, trace => manifest.tasks.find(task => task.taskId === trace.taskId).category).map(rows => ({
      category: manifest.tasks.find(task => task.taskId === rows[0].taskId).category,
      runCount: rows.length, verifiedResults: new Set(rows.filter(trace => trace.verification.verified === true).map(blockKey)).size,
    }));
    return {
      evidenceKind, strategy, runCount: traces.length, attemptCount: attempts.length, verifiedResults,
      outcomes: Object.fromEntries(OUTCOMES.map(outcome => [outcome, attempts.filter(attempt => attempt.outcome === outcome).length])),
      latencyMs: latency(attempts), models, classes, coverageIssues, missingBlocks, costs,
    };
  });
  const pairedOutcomes = evidenceKinds.flatMap(evidenceKind => manifest.tasks.flatMap(task => manifest.repetitions.map(repetition => ({
    evidenceKind, taskId: task.taskId, category: task.category, criticality: task.criticality, repetition,
    outcomes: manifest.strategies.map(strategy => {
      const runs = trajectories.filter(trace => trace.provenance.kind === evidenceKind && trace.taskId === task.taskId && trace.repetition === repetition && trace.strategy === strategy);
      return {
        strategy, runIds: runs.map(trace => trace.runId),
        verified: runs.some(trace => trace.verification.verified === true) ? true : runs.length > 0 && runs.every(trace => trace.verification.verified === false) ? false : null,
      };
    }),
  }))));
  return {
    version: 1, mode: 'offline', localGradingExecuted: false,
    empiricalSavings: null, defaultChangeAuthorized: false,
    manifest, duplicateRecords, assessments, summaryEvidenceKind: summary?.evidenceKind ?? null,
    cohort: summary?.cohort ?? null, quality: summary?.quality ?? null,
    pairedOutcomes, strata, trajectories,
  };
}
