# Astra Project Forge v2.6.1 — Efficiency First Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Adaptive Efficiency Governor to Astra Project Forge v2.6.0 that removes redundant computation while preserving verified-result quality.

**Architecture:** Keep the existing v2.6 local-first MCP surface and state model. Add small deterministic modules for utility gating, evidence freshness/fingerprints, context delta/compaction, and efficiency accounting; then integrate them into the existing router, state store, MCP tools, skill policy, and release docs. Efficiency decisions use observable signals only—never invented token, billing, cache-hit, or cost data.

**Tech Stack:** Node.js >=20, ES modules, Node built-in `node:test`, stdio MCP, JSON local state, no runtime dependencies.

**Spec:** `astra-project-forge-v2.6.1-efficiency-design.md`

## Global Constraints

- Default efficiency policy: `balanced`.
- Policies: `eco`, `balanced`, `performance`, `maximum`.
- Existing routing profiles stay `off`, `light`, `standard`, `deep`.
- Cycle limits become soft budgets; useful work may exceed them.
- Never reject useful work merely because the soft budget is exceeded.
- Stop immediately after sufficiently verified success.
- Preserve all v2.6 `forge_*` and v2.5 `adaptive_*` compatibility.
- Preserve local-first storage, stdio startup, permissions, and AGPL-3.0-only.
- No hidden chain-of-thought storage, cloud sync, self-modification, fake telemetry, or AGI claims.

---

### Task 1: Adaptive Efficiency Governor

**Files**
- Create: `server/efficiency-governor.mjs`
- Create: `tests/v261-efficiency-governor.test.mjs`

**Produces**
- `normalizeEfficiencyPolicy(value)`
- `policyBudget(policy, routeProfile)`
- `assessUtility(input)`
- `shouldComplete(input)`
- `nextReasoningLevel(input)`

- [ ] **Step 1: Write failing tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEfficiencyPolicy,
  policyBudget,
  assessUtility,
  shouldComplete,
  nextReasoningLevel,
} from '../server/efficiency-governor.mjs';

test('balanced is default', () => {
  assert.equal(normalizeEfficiencyPolicy(), 'balanced');
});

test('useful work may exceed soft budget', () => {
  const result = assessUtility({
    completedCycles: 3,
    softCycleBudget: 3,
    unmetSuccessCriteria: ['package not verified'],
    importantUncertainty: true,
    candidateWouldProduceNewEvidence: true,
  });
  assert.equal(result.decision, 'allow');
  assert.equal(result.requiresJustification, true);
});

test('verified success stops immediately', () => {
  assert.equal(shouldComplete({
    successCriteriaSatisfied: true,
    evidenceSufficient: true,
    contradictionRemaining: false,
    meaningfulRiskRemaining: false,
  }), true);
});

test('hysteresis prevents immediate effort oscillation', () => {
  const result = nextReasoningLevel({
    currentLevel: 'high',
    importantUncertainty: false,
    highRisk: false,
    recentlyEscalated: true,
    successCriteriaSatisfied: false,
  });
  assert.equal(result.level, 'high');
});
```

- [ ] **Step 2: Run**

```bash
node --test tests/v261-efficiency-governor.test.mjs
```

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement minimal governor**

```js
export const EFFICIENCY_POLICIES = ['eco', 'balanced', 'performance', 'maximum'];
export const REASONING_LEVELS = ['low', 'medium', 'high', 'maximum'];

export function normalizeEfficiencyPolicy(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return EFFICIENCY_POLICIES.includes(v) ? v : 'balanced';
}

export function policyBudget(policyInput, routeProfile = 'standard') {
  const policy = normalizeEfficiencyPolicy(policyInput);
  const table = {
    eco:         { off: 0, light: 1, standard: 1, deep: 2 },
    balanced:    { off: 0, light: 1, standard: 3, deep: 3 },
    performance: { off: 0, light: 1, standard: 3, deep: 5 },
    maximum:     { off: 0, light: 1, standard: 4, deep: 6 },
  };
  return {
    softCycleBudget: table[policy][routeProfile] ?? table[policy].standard,
    contextPreference: policy === 'eco' ? 'summary' : 'working',
  };
}

export function shouldComplete(input = {}) {
  return input.successCriteriaSatisfied === true
    && input.evidenceSufficient === true
    && input.contradictionRemaining !== true
    && input.meaningfulRiskRemaining !== true;
}

export function assessUtility(input = {}) {
  if (shouldComplete(input)) {
    return { decision: 'stop', usefulReasons: [], wasteReasons: ['success_verified'], requiresJustification: false };
  }

  const usefulReasons = [];
  if (Array.isArray(input.unmetSuccessCriteria) && input.unmetSuccessCriteria.length) usefulReasons.push('unmet_success_criterion');
  if (input.importantUncertainty === true) usefulReasons.push('important_uncertainty');
  if (input.meaningfulRiskRemaining === true) usefulReasons.push('high_risk_verification');
  if (input.contradictionRemaining === true) usefulReasons.push('contradictory_evidence');
  if (input.candidateWouldProduceNewEvidence === true) usefulReasons.push('new_evidence');

  const wasteReasons = [];
  if (input.duplicateValidEvidence === true) wasteReasons.push('duplicate_valid_evidence');
  if (input.repeatsFailedStrategyWithoutNewEvidence === true) wasteReasons.push('repeated_failed_strategy');
  if (input.irrelevantContextReload === true) wasteReasons.push('irrelevant_context');
  if (input.noExpectedDecisionImpact === true) wasteReasons.push('no_expected_decision_impact');

  const exceeded = Number(input.completedCycles ?? 0) >= Number(input.softCycleBudget ?? Infinity);
  if (usefulReasons.length) return { decision: 'allow', usefulReasons, wasteReasons, requiresJustification: exceeded };
  if (wasteReasons.length) return { decision: 'skip', usefulReasons, wasteReasons, requiresJustification: false };
  return { decision: exceeded ? 'justify' : 'allow', usefulReasons, wasteReasons, requiresJustification: exceeded };
}

export function nextReasoningLevel(input = {}) {
  const current = REASONING_LEVELS.includes(input.currentLevel) ? input.currentLevel : 'low';
  const i = REASONING_LEVELS.indexOf(current);
  if ((input.highRisk === true || input.importantUncertainty === true) && Number(input.unresolvedCycles ?? 0) >= 1) {
    const level = REASONING_LEVELS[Math.min(i + 1, REASONING_LEVELS.length - 1)];
    return { level, changed: level !== current, reason: 'value_justifies_escalation' };
  }
  if (input.recentlyEscalated === true && !input.successCriteriaSatisfied) {
    return { level: current, changed: false, reason: 'hysteresis_hold' };
  }
  if (i > 0 && input.importantUncertainty !== true && input.highRisk !== true) {
    return { level: REASONING_LEVELS[i - 1], changed: true, reason: 'risk_reduced' };
  }
  return { level: current, changed: false, reason: 'no_change' };
}
```

- [ ] **Step 4: Verify green**

```bash
node --test tests/v261-efficiency-governor.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add server/efficiency-governor.mjs tests/v261-efficiency-governor.test.mjs
git commit -m "feat: add adaptive efficiency governor"
```

---

### Task 2: Policy-aware soft budgets in the existing router

**Files**
- Modify: `server/adaptive-router.mjs`
- Create: `tests/v261-router-efficiency.test.mjs`
- Regression: `tests/v26-router.test.mjs`

- [ ] **Step 1: Write failing tests**

```js
test('balanced deep work uses soft budget three', () => {
  const route = routeTask({
    complexity: 'complex',
    uncertainty: 'high',
    continuityNeeded: true,
    efficiencyPolicy: 'balanced',
  });
  assert.equal(route.profile, 'deep');
  assert.equal(route.softCycleBudget, 3);
  assert.equal(route.cycleBudget, 3);
});

test('high-value work continues past the soft budget', () => {
  const route = routeTask({
    complexity: 'complex',
    uncertainty: 'high',
    completedCycles: 3,
    unmetSuccessCriteria: ['fresh verification'],
    candidateWouldProduceNewEvidence: true,
  });
  assert.equal(route.efficiencyDecision, 'allow');
  assert.equal(route.requiresJustification, true);
});

test('completed work is stopped even when route would otherwise be deep', () => {
  const route = routeTask({
    complexity: 'complex',
    uncertainty: 'high',
    successCriteriaSatisfied: true,
    evidenceSufficient: true,
    contradictionRemaining: false,
    meaningfulRiskRemaining: false,
  });
  assert.equal(route.completionRecommended, true);
  assert.equal(route.efficiencyDecision, 'stop');
});
```

- [ ] **Step 2: Run and confirm new tests fail**

```bash
node --test tests/v26-router.test.mjs tests/v261-router-efficiency.test.mjs
```

- [ ] **Step 3: Integrate Task 1 into `routeTask()`**

```js
import {
  normalizeEfficiencyPolicy,
  policyBudget,
  assessUtility,
  shouldComplete,
} from './efficiency-governor.mjs';
```

After profile selection:

```js
const efficiencyPolicy = normalizeEfficiencyPolicy(input.efficiencyPolicy);
const efficiency = policyBudget(efficiencyPolicy, profile);
const utility = assessUtility({ ...input, softCycleBudget: efficiency.softCycleBudget });
const completionRecommended = shouldComplete(input);
```

Return additions:

```js
efficiencyPolicy,
softCycleBudget: efficiency.softCycleBudget,
cycleBudget: efficiency.softCycleBudget,
requiresJustification: utility.requiresJustification,
efficiencyDecision: utility.decision,
completionRecommended,
```

- [ ] **Step 4: Run router regression**

```bash
node --test tests/v26-router.test.mjs tests/v261-router-efficiency.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add server/adaptive-router.mjs tests/v261-router-efficiency.test.mjs
git commit -m "feat: make Forge routing efficiency-aware"
```

---

### Task 3: Evidence freshness, fingerprinting, and invalidation

**Files**
- Create: `server/evidence-cache.mjs`
- Create: `tests/v261-evidence-cache.test.mjs`

- [ ] **Step 1: Write failing tests**

```js
test('dependency order does not change fingerprint', () => {
  assert.equal(
    fingerprintDependencies(['a@1', 'b@2']),
    fingerprintDependencies(['b@2', 'a@1']),
  );
});

test('dependency change makes evidence stale', () => {
  const record = {
    freshness: 'fresh',
    dependencyFingerprint: fingerprintDependencies(['a@1']),
  };
  assert.equal(freshnessFor(record, ['a@2']), 'stale');
});

test('high-risk work does not reuse probably-fresh evidence', () => {
  const record = {
    freshness: 'probably_fresh',
    dependencyFingerprint: fingerprintDependencies([]),
  };
  assert.equal(canReuseEvidence(record, { risk: 'high', dependencies: [] }), false);
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
node --test tests/v261-evidence-cache.test.mjs
```

- [ ] **Step 3: Implement**

```js
import { createHash } from 'node:crypto';

const sorted = values => [...new Set((values ?? []).map(String).filter(Boolean))].sort();

export function fingerprintDependencies(values = []) {
  return createHash('sha256').update(JSON.stringify(sorted(values))).digest('hex');
}

export function makeEvidenceKey(input = {}) {
  return createHash('sha256').update(JSON.stringify({
    kind: String(input.kind ?? ''),
    target: String(input.target ?? ''),
    params: input.params ?? null,
    dependencies: sorted(input.dependencies),
  })).digest('hex');
}

export function freshnessFor(record = {}, dependencies = []) {
  if (record.freshness === 'invalidated') return 'invalidated';
  if (record.dependencyFingerprint
      && record.dependencyFingerprint !== fingerprintDependencies(dependencies)) return 'stale';
  return ['fresh', 'probably_fresh', 'stale'].includes(record.freshness)
    ? record.freshness
    : 'probably_fresh';
}

export function canReuseEvidence(record = {}, input = {}) {
  const freshness = freshnessFor(record, input.dependencies);
  if (freshness === 'invalidated' || freshness === 'stale') return false;
  if (freshness === 'probably_fresh' && input.risk === 'high') return false;
  return true;
}

export function invalidateByChangedDependency(records = [], changedIds = []) {
  const changed = new Set(changedIds.map(String));
  return records.map(record => ({
    ...record,
    freshness: Array.isArray(record.dependencyIds)
      && record.dependencyIds.some(id => changed.has(String(id)))
      ? 'stale'
      : record.freshness,
  }));
}
```

- [ ] **Step 4: Verify green**

```bash
node --test tests/v261-evidence-cache.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add server/evidence-cache.mjs tests/v261-evidence-cache.test.mjs
git commit -m "feat: add evidence reuse and invalidation"
```

---

### Task 4: Context delta, compaction, and progressive results

**Files**
- Create: `server/context-efficiency.mjs`
- Create: `tests/v261-context-efficiency.test.mjs`

- [ ] **Step 1: Write failing tests**

```js
test('delta selects records after requested revision', () => {
  const items = [{ id: 'a', revision: 2 }, { id: 'b', revision: 4 }];
  assert.deepEqual(selectDelta(items, 2).map(x => x.id), ['b']);
});

test('compaction keeps active goals and unresolved claims', () => {
  const result = compactContext({
    projectId: 'p',
    goalGraph: [{ id: 'g1', status: 'verified' }, { id: 'g2', status: 'active' }],
    claims: [{ id: 'c1', status: 'known' }, { id: 'c2', status: 'unknown' }],
    lessons: ['verified lesson'],
  });
  assert.deepEqual(result.activeGoals.map(x => x.id), ['g2']);
  assert.deepEqual(result.unresolvedClaims.map(x => x.id), ['c2']);
});

test('progressive result defaults to summary', () => {
  const value = progressiveResult({
    summary: { count: 2 },
    relevant: [{ id: 'a' }],
    full: [{ id: 'a' }, { id: 'b' }],
  });
  assert.deepEqual(value, { count: 2 });
});
```

- [ ] **Step 2: Confirm failure**

```bash
node --test tests/v261-context-efficiency.test.mjs
```

- [ ] **Step 3: Implement**

```js
export function selectDelta(items = [], sinceRevision = 0) {
  return items.filter(item => Number(item.revision ?? 0) > Number(sinceRevision ?? 0));
}

export function compactContext(project = {}) {
  return {
    activeGoals: (project.goalGraph ?? []).filter(g => ['active', 'pending', 'blocked'].includes(g.status)),
    unresolvedClaims: (project.claims ?? []).filter(c => ['unknown', 'contradicted', 'inferred'].includes(c.status)),
    verifiedLessons: [...(project.lessons ?? [])],
    recentEvaluations: (project.evaluations ?? []).slice(-5),
    latestCheckpoint: (project.checkpoints ?? []).at(-1) ?? null,
    archiveRef: { projectId: project.projectId, schemaVersion: project.schemaVersion },
  };
}

export function progressiveResult(payload = {}, level = 'summary') {
  if (level === 'full') return payload.full ?? payload.relevant ?? payload.summary ?? null;
  if (level === 'relevant') return payload.relevant ?? payload.summary ?? null;
  return payload.summary ?? null;
}
```

- [ ] **Step 4: Verify green**

```bash
node --test tests/v261-context-efficiency.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add server/context-efficiency.mjs tests/v261-context-efficiency.test.mjs
git commit -m "feat: add context efficiency helpers"
```

---

### Task 5: Persist efficiency state and ledger additively

**Files**
- Create: `server/efficiency-ledger.mjs`
- Modify: `server/state-store.mjs`
- Modify: `server/agent-state.mjs`
- Create: `tests/v261-state-migration.test.mjs`

**Project additions**
- `revision`
- `efficiency.policy`
- `efficiency.reasoningLevel`
- `efficiency.recentlyEscalated`
- `efficiency.evidenceCache`
- `efficiency.failedStrategies`
- `efficiency.ledger`

- [ ] **Step 1: Write failing migration test**

```js
test('v2.6 state gains efficiency defaults without losing data', async () => {
  const project = await store.getProject('legacy-v26');
  assert.equal(project.efficiency.policy, 'balanced');
  assert.equal(project.efficiency.ledger.usefulCycles, 0);
  assert.ok(Number.isInteger(project.revision));
  assert.equal(project.observations[0].id, 'obs-1');
});
```

- [ ] **Step 2: Run migration regression**

```bash
node --test tests/v26-migration.test.mjs tests/v261-state-migration.test.mjs
```

- [ ] **Step 3: Implement ledger**

```js
export function emptyEfficiencyLedger() {
  return {
    usefulCycles: 0,
    avoidedCycles: 0,
    reusedEvidence: 0,
    duplicateToolCallsAvoided: 0,
    contextsCompacted: 0,
    reasoningEscalations: 0,
    softBudgetOverrides: 0,
    stopReason: null,
  };
}

export function applyEfficiencyEvent(ledger, event = {}) {
  const next = { ...emptyEfficiencyLedger(), ...(ledger ?? {}) };
  const counters = new Set([
    'usefulCycles',
    'avoidedCycles',
    'reusedEvidence',
    'duplicateToolCallsAvoided',
    'contextsCompacted',
    'reasoningEscalations',
    'softBudgetOverrides',
  ]);
  if (counters.has(event.type)) next[event.type] += Number(event.amount ?? 1);
  if (event.type === 'stop') next.stopReason = String(event.reason ?? 'UNKNOWN');
  return next;
}
```

- [ ] **Step 4: Add state normalization**

```js
function normalizeEfficiency(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    policy: normalizeEfficiencyPolicy(source.policy),
    reasoningLevel: ['low', 'medium', 'high', 'maximum'].includes(source.reasoningLevel)
      ? source.reasoningLevel
      : 'low',
    recentlyEscalated: source.recentlyEscalated === true,
    evidenceCache: Array.isArray(source.evidenceCache) ? source.evidenceCache : [],
    failedStrategies: Array.isArray(source.failedStrategies) ? source.failedStrategies : [],
    ledger: { ...emptyEfficiencyLedger(), ...(source.ledger ?? {}) },
  };
}
```

`normalizeProject()` adds:

```js
revision: Number.isInteger(project.revision) ? project.revision : 0,
efficiency: normalizeEfficiency(project.efficiency),
```

Every successful `#write()` increments:

```js
project.revision = Number(project.revision ?? 0) + 1;
```

- [ ] **Step 5: Add store methods**

```js
async setEfficiencyPolicy(projectId, policy) { /* normalize, persist, return efficiency */ }
async recordEfficiencyEvent(projectId, event) { /* apply ledger event, persist */ }
async upsertEvidenceRecord(projectId, record) { /* replace same key or append */ }
async invalidateEvidence(projectId, changedIds) { /* smart invalidation */ }
```

Implement each exactly using the new helper modules; no network or billing calls.

- [ ] **Step 6: Run state tests**

```bash
node --test tests/state-store.test.mjs tests/v26-migration.test.mjs tests/v261-state-migration.test.mjs
```

- [ ] **Step 7: Commit**

```bash
git add server/state-store.mjs server/agent-state.mjs server/efficiency-ledger.mjs tests/v261-state-migration.test.mjs
git commit -m "feat: persist Forge efficiency state"
```

---

### Task 6: Anti-thrashing and risk-weighted planning

**Files**
- Modify: `server/agent-state.mjs`
- Modify: `server/state-store.mjs`
- Create: `tests/v261-anti-thrashing.test.mjs`

- [ ] **Step 1: Write failing tests**

```js
test('failed strategy cannot repeat unchanged without new evidence', async () => {
  const first = await store.addPlan('p', {
    action: 'Retry same parser config',
    why: 'diagnostic',
    strategyKey: 'parser-same-config',
  });
  await store.addEvaluation('p', {
    planId: first.id,
    outcome: 'falsified',
    summary: 'same config disproven',
  });

  await assert.rejects(
    store.addPlan('p', {
      action: 'Retry same parser config',
      why: 'repeat',
      strategyKey: 'parser-same-config',
    }),
    /failed strategy/i,
  );
});

test('new evidence allows reconsideration', async () => {
  const plan = await store.addPlan('p', {
    action: 'Retry after dependency changed',
    why: 'new evidence',
    strategyKey: 'parser-same-config',
    newEvidenceIds: ['ev-dependency-change'],
  });
  assert.equal(plan.strategyKey, 'parser-same-config');
});
```

- [ ] **Step 2: Confirm failure**

```bash
node --test tests/v261-anti-thrashing.test.mjs
```

- [ ] **Step 3: Extend plan records**

Add:

```js
export function verificationStrength(risk = 'medium') {
  return { low: 'light', medium: 'standard', high: 'strong' }[risk] ?? 'standard';
}
```

Plan record additions:

```js
strategyKey: input?.strategyKey == null ? null : requireString(input.strategyKey, 'strategyKey'),
verificationRisk: ['low', 'medium', 'high'].includes(input?.verificationRisk) ? input.verificationRisk : 'medium',
verificationStrength: verificationStrength(input?.verificationRisk),
expectedDecisionImpact: ['none', 'low', 'medium', 'high'].includes(input?.expectedDecisionImpact)
  ? input.expectedDecisionImpact
  : 'medium',
newEvidenceIds: stringArray(input?.newEvidenceIds, 'newEvidenceIds'),
```

- [ ] **Step 4: Reject unchanged failed strategy in `ProjectStore.addPlan()`**

```js
if (input?.strategyKey) {
  const failed = project.plans
    .filter(plan => plan.strategyKey === input.strategyKey)
    .some(plan => project.evaluations.some(
      ev => ev.planId === plan.id && ['falsified', 'blocked'].includes(ev.outcome),
    ));
  const hasNewEvidence = Array.isArray(input.newEvidenceIds) && input.newEvidenceIds.length > 0;
  if (failed && !hasNewEvidence) {
    throw new Error(`Failed strategy cannot be repeated unchanged without new evidence: ${input.strategyKey}`);
  }
}
```

- [ ] **Step 5: Regression**

```bash
node --test tests/v26-plan-evaluate-adapt.test.mjs tests/v261-anti-thrashing.test.mjs
```

- [ ] **Step 6: Commit**

```bash
git add server/agent-state.mjs server/state-store.mjs tests/v261-anti-thrashing.test.mjs
git commit -m "feat: prevent wasteful strategy thrashing"
```

---

### Task 7: Integrate efficiency into existing MCP tools without adding a mandatory governor call

**Files**
- Modify: `server/mcp-server.mjs`
- Modify: `server/state-store.mjs`
- Create: `tests/v261-mcp-integration.test.mjs`

**Optional fields**
- `forge_route.efficiencyPolicy`
- `forge_route.completedCycles`
- completion/utility signals
- `forge_context.sinceRevision`
- `forge_context.resultLevel`
- `forge_adapt` operations:
  - `set_efficiency_policy`
  - `record_efficiency_event`
  - `invalidate_evidence`

- [ ] **Step 1: Write failing MCP tests**

```js
test('forge_route exposes efficiency metadata', async () => {
  const result = await call('forge_route', {
    complexity: 'complex',
    uncertainty: 'high',
    efficiencyPolicy: 'balanced',
    completedCycles: 3,
    unmetSuccessCriteria: ['package verification'],
    candidateWouldProduceNewEvidence: true,
  });
  assert.equal(result.structuredContent.route.efficiencyPolicy, 'balanced');
  assert.equal(result.structuredContent.route.requiresJustification, true);
});

test('legacy adaptive tools remain listed', async () => {
  const tools = await listTools();
  assert.ok(tools.some(x => x.name === 'adaptive_route_task'));
  assert.ok(tools.some(x => x.name === 'forge_route'));
});
```

- [ ] **Step 2: Run compatibility suite**

```bash
node --test tests/v25-mcp-tools.test.mjs tests/v26-mcp-tools.test.mjs tests/v261-mcp-integration.test.mjs
```

- [ ] **Step 3: Extend existing schemas only with optional fields**

Example:

```js
efficiencyPolicy: { type: 'string', enum: ['eco', 'balanced', 'performance', 'maximum'] },
completedCycles: { type: 'integer', minimum: 0 },
successCriteriaSatisfied: { type: 'boolean' },
evidenceSufficient: { type: 'boolean' },
importantUncertainty: { type: 'boolean' },
contradictionRemaining: { type: 'boolean' },
meaningfulRiskRemaining: { type: 'boolean' },
candidateWouldProduceNewEvidence: { type: 'boolean' },
duplicateValidEvidence: { type: 'boolean' },
```

For `forge_context`:

```js
sinceRevision: { type: 'integer', minimum: 0 },
resultLevel: { type: 'string', enum: ['summary', 'relevant', 'full'] },
```

- [ ] **Step 4: Add efficiency operations to `forge_adapt`**

```js
if (args.operation === 'set_efficiency_policy') {
  const efficiency = await store.setEfficiencyPolicy(args.projectId, args.efficiencyPolicy);
  return textResult('Forge efficiency policy updated.', { efficiency });
}

if (args.operation === 'record_efficiency_event') {
  const ledger = await store.recordEfficiencyEvent(args.projectId, {
    type: args.eventType,
    amount: args.amount,
    reason: args.reason,
  });
  return textResult('Forge efficiency event recorded.', { ledger });
}

if (args.operation === 'invalidate_evidence') {
  const evidenceCache = await store.invalidateEvidence(args.projectId, args.changedDependencyIds);
  return textResult('Forge evidence invalidated where dependencies changed.', { evidenceCache });
}
```

- [ ] **Step 5: Run MCP tests**

```bash
node --test tests/v25-mcp-tools.test.mjs tests/v26-mcp-tools.test.mjs tests/v261-mcp-integration.test.mjs
```

- [ ] **Step 6: Commit**

```bash
git add server/mcp-server.mjs server/state-store.mjs tests/v261-mcp-integration.test.mjs
git commit -m "feat: integrate efficiency with Forge MCP"
```

---

### Task 8: Make Efficiency First normative in the skill

**Files**
- Modify: `skills/astra-project-forge/SKILL.md`
- Create: `tests/v261-skill-efficiency.test.mjs`
- Regression: `tests/v25-skill-policy.test.mjs`

- [ ] **Step 1: Write failing content tests**

```js
assert.match(text, /Efficiency First/i);
assert.match(text, /useful computation is not waste/i);
assert.match(text, /justify-before-spend/i);
assert.match(text, /soft budget/i);
assert.match(text, /marginal value/i);
assert.match(text, /anti-thrashing/i);
assert.match(text, /do not fabricate/i);
```

- [ ] **Step 2: Run and confirm failure**

```bash
node --test tests/v25-skill-policy.test.mjs tests/v261-skill-efficiency.test.mjs
```

- [ ] **Step 3: Add this normative section**

```md
## Efficiency First

Default to the `balanced` efficiency policy.

Before additional expensive work, determine whether it is likely to improve a
decision, satisfy an unmet success criterion, resolve important uncertainty,
produce new evidence, reduce meaningful risk, or unblock progress.

**Useful computation is not waste.** Soft budgets guide work; they do not block
useful work. After a soft budget is reached, use **justify-before-spend**:
record a decision-relevant reason before another expensive cycle.

Avoid repeated fresh evidence, irrelevant context reloads, duplicate tool
calls, unchanged failed strategies, and work that continues after verified
success.

Use marginal value: stop repeated verification when another check is unlikely
to change the decision. Prefer delta context, progressive tool results, cheap
diagnostics before expensive actions, risk-weighted verification, and safe
action coalescing.

Do not fabricate token counts, compute usage, cache hits, billing, or savings
when the host does not expose those measurements.
```

Add completion rule:

```md
When success criteria are satisfied, evidence is sufficient, no important
contradiction remains, and no meaningful unresolved risk remains, stop
immediately even if workflow budget remains.
```

- [ ] **Step 4: Verify green**

```bash
node --test tests/v25-skill-policy.test.mjs tests/v261-skill-efficiency.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add skills/astra-project-forge/SKILL.md tests/v261-skill-efficiency.test.mjs
git commit -m "docs: make Forge efficiency-first"
```

---

### Task 9: Deterministic benchmark and quality floor

**Files**
- Create: `scripts/benchmark-v261.mjs`
- Create: `tests/v261-benchmark.test.mjs`
- Modify: `package.json`

**Metrics**
- `verifiedSuccess`
- `cycles`
- `toolCalls`
- `duplicateToolCalls`
- `contextUnits`
- `reusedEvidence`
- `retries`

No fake real-world tokens or billing.

- [ ] **Step 1: Write failing benchmark tests**

```js
test('efficiency preserves verified success', () => {
  for (const scenario of benchmarkScenarios()) {
    const baseline = runBenchmarkScenario(scenario, 'v260_baseline');
    const efficient = runBenchmarkScenario(scenario, 'v261_efficiency');
    assert.equal(efficient.verifiedSuccess, baseline.verifiedSuccess);
  }
});

test('duplicate-heavy workload uses fewer tool calls', () => {
  const scenario = benchmarkScenarios().find(x => x.id === 'duplicate-heavy');
  const baseline = runBenchmarkScenario(scenario, 'v260_baseline');
  const efficient = runBenchmarkScenario(scenario, 'v261_efficiency');
  assert.ok(efficient.toolCalls < baseline.toolCalls);
});

test('useful cycle beyond budget is kept', () => {
  const scenario = benchmarkScenarios().find(x => x.id === 'useful-over-budget');
  const efficient = runBenchmarkScenario(scenario, 'v261_efficiency');
  assert.equal(efficient.verifiedSuccess, true);
  assert.ok(efficient.cycles > scenario.softBudget);
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
node --test tests/v261-benchmark.test.mjs
```

- [ ] **Step 3: Implement deterministic scenarios**

```js
export function benchmarkScenarios() {
  return [
    {
      id: 'duplicate-heavy',
      softBudget: 3,
      actions: [
        { useful: true, toolKey: 'read:a', newEvidence: true },
        { useful: false, toolKey: 'read:a', duplicate: true },
        { useful: false, toolKey: 'read:a', duplicate: true },
        { useful: true, toolKey: 'test:a', newEvidence: true, completes: true },
      ],
    },
    {
      id: 'useful-over-budget',
      softBudget: 2,
      actions: [
        { useful: true, newEvidence: true },
        { useful: true, newEvidence: true },
        { useful: true, newEvidence: true, completes: true },
      ],
    },
  ];
}
```

Efficient mode skips duplicate/no-value actions, but never skips an action required for verified completion.

- [ ] **Step 4: Add scripts**

```json
"benchmark:efficiency": "node scripts/benchmark-v261.mjs"
```

Extend `npm run check` with all new server modules.

- [ ] **Step 5: Verify**

```bash
npm run benchmark:efficiency
node --test tests/v261-benchmark.test.mjs
```

- [ ] **Step 6: Commit**

```bash
git add scripts/benchmark-v261.mjs tests/v261-benchmark.test.mjs package.json
git commit -m "test: add Forge efficiency benchmark"
```

---

### Task 10: Release metadata, docs, full regression, and package verification

**Files**
- Modify: `.codex-plugin/plugin.json`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/TOOLS.md`
- Create: `docs/DESIGN-v2.6.1.md`
- Output: `astra-project-forge-local-2.6.1.zip`
- Output: `astra-project-forge-local-marketplace-2.6.1.zip`

- [ ] **Step 1: Bump both versions to `2.6.1` and keep**

```json
"license": "AGPL-3.0-only"
```

- [ ] **Step 2: Document**

README must state:

```text
Efficiency First
- BALANCED is default.
- Soft budgets guide; they do not block useful work.
- Justify-before-spend applies after the soft budget.
- Fresh evidence is reused when safe.
- Delta/compacted context is preferred.
- Duplicate calls and unchanged failed strategies are avoided.
- Verification scales with risk.
- Verified success stops work immediately.
- Forge never invents usage/cost savings.
```

`docs/TOOLS.md` must mark all v2.6.1 fields optional.

- [ ] **Step 3: Copy approved design to**

```text
docs/DESIGN-v2.6.1.md
```

- [ ] **Step 4: Full fresh verification**

```bash
npm run check
npm test
npm run benchmark:efficiency
```

Required: exit code 0, 0 failed tests, benchmark quality floor preserved.

- [ ] **Step 5: Verify stdio from unrelated CWD**

```bash
cd /tmp
printf '%s\n' \
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"v261-check","version":"1"}}}' \
| node /ABSOLUTE/PATH/TO/astra-project-forge/server/mcp-server.mjs --stdio
```

Expected server version: `2.6.1`.

- [ ] **Step 6: Verify tools**

Confirm all existing 9 `forge_*` and 10 legacy `adaptive_*` tools remain discoverable.

- [ ] **Step 7: Build both ZIPs, re-extract them, and rerun**

```bash
npm run check
npm test
npm run benchmark:efficiency
```

from the freshly extracted plugin.

- [ ] **Step 8: Verify required release files**

```text
.codex-plugin/plugin.json
.mcp.json
LICENSE
NOTICE.md
ATTRIBUTION.md
README.md
server/
skills/
tests/
docs/
package.json
```

- [ ] **Step 9: Final commit**

```bash
git add -A
git commit -m "release: Astra Project Forge v2.6.1 Efficiency First"
```

Do not push or merge without the user's integration choice.

---

## Self-Review

Coverage:
- Utility + marginal-value behavior: Tasks 1–2
- Soft budgets + justify-before-spend: Tasks 1–2, 8
- Quality floor: Tasks 1, 9
- Evidence freshness/fingerprints/invalidation: Tasks 3, 5
- Delta context/compaction/progressive results: Tasks 4, 7
- Deduplication and anti-thrashing: Tasks 3, 6
- Risk-weighted verification: Task 6
- Adaptive reasoning + hysteresis: Tasks 1, 5, 8
- Completion gate: Tasks 1–2, 8
- Efficiency ledger: Task 5
- Benchmark harness: Task 9
- Compatibility and packaging: Tasks 7, 10

Deliberate scope limits:
- No new mandatory MCP call just to ask whether another call is efficient.
- No fake token/cost/cache metrics.
- No hard cycle cap that can prevent success.
- No forced parallelism or cloud dependency.
