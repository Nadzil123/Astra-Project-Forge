# Astra Project Forge 2.6.1 — MCP Tools

## Primary v2.6 tools

- `forge_route` — choose `off|light|standard|deep`, context depth, and qualitative usage impact.
- `forge_goal` — list/create/update goal-graph nodes and evidence-backed verification state.
- `forge_context` — retrieve `summary|working|full|recovery` context.
- `forge_observe` — record observations, epistemic claims, claim updates, and transfer candidates/validation.
- `forge_plan` — record a concise next-action plan.
- `forge_evaluate` — evaluate results against criteria/evidence.
- `forge_adapt` — record failure diagnosis/changed strategy or usage-notice acknowledgement.
- `forge_checkpoint` — create a resumable checkpoint.
- `forge_consolidate` — consolidate verified results and lessons.

## Compatibility tools

The v2.5 `adaptive_*` tool set remains available for existing clients and stored workflows.

There are still nine `forge_*` and ten `adaptive_*` names. No new mandatory call
is needed to ask whether another call is efficient. Existing required arguments
and default return envelopes remain compatible.

## Optional v2.6.1 inputs

**Every new v2.6.1 input is optional at the tool level.** Selecting a new
operation or supplying an optional object requires its associated data, as
described below. These conditional requirements do not change legacy calls.
Inputs are caller reports, not automatic measurements of external work.

### Routing and policy

`forge_route` optionally accepts `efficiencyPolicy` (`eco|balanced|performance|maximum`),
`completedCycles` (nonnegative safe integer), and `unmetSuccessCriteria` (string
array). Policy precedence is call override, stored project policy, then
`balanced`. A call override does not change the stored policy. Cycle position
defaults to the last caller report, initially zero; explicit zero resets it.

Profiles remain `off|light|standard|deep`. `cycleBudget` and `softCycleBudget`
are soft guidance, never hard limits on useful work:

| Policy | off | light | standard | deep |
| --- | --- | --- | --- | --- |
| eco | 0 | 1 | 1 | 2 |
| balanced | 0 | 1 | 3 | 3 |
| performance | 0 | 1 | 3 | 5 |
| maximum | 0 | 1 | 4 | 6 |

Optional candidate booleans:
`candidateWouldVerifySuccessCriterion`, `candidateWouldResolveUncertainty`,
`candidateWouldReduceRisk`, `candidateWouldResolveContradiction`,
`candidateWouldProduceNewEvidence`, `candidateWouldChangeDecision`,
`candidateWouldDetectFailure`, `candidateWouldUnblockDependency`,
`candidateWouldMakeProgress`, `newEvidenceRequiresReplan`, `candidateWouldReplan`,
`candidateHasIndependentValue`, `duplicateValidEvidence`,
`repeatsFailedStrategyWithoutNewEvidence`, `irrelevantContextReload`,
`noExpectedDecisionImpact`, `alreadySufficientlyVerified`, `duplicateConcurrentAction`.

Optional completion/need booleans: `successCriteriaSatisfied`, `evidenceSufficient`,
`importantUncertainty`, `contradictionRemaining`, `meaningfulRiskRemaining`.
Completion requires satisfied success criteria AND sufficient evidence AND no
important contradiction AND no meaningful unresolved risk; stop immediately
when all hold. An unmet project goal alone does not establish candidate utility.

Optional reasoning inputs: `unresolvedCycles` (nonnegative safe integer),
`currentLevel` (`low|medium|high|maximum`), and booleans `recentlyEscalated`,
`recentlyDeescalated`, `exceptionalDifficulty`, `highRisk`, `uncertaintyResolved`,
`riskReducedMaterially`. Persisted level/recency supply defaults. Existing high
route risk cannot be weakened with `highRisk:false`. Recommendations do not
control host reasoning or count executed escalations.

The existing `{route,noticeRequired,deepNoticeRequired}` envelope remains.
Additive route outputs include policy/budget, `efficiencyDecision`
(`allow|justify|skip|stop`, or `reuse` on a cache hit), `requiresJustification`,
`usefulReasons`, `wasteReasons`, `completionRecommended`, and
`reasoningRecommendation:{level,changed,reason}`. Routing without a project is
stateless. Project routing persists guidance, not executed-work counters.

### Evidence registration and reuse

`forge_observe` with `operation:'observation'` optionally accepts `evidenceRecord`.
When supplied, it requires nonempty `evidenceId`, `kind`, `target`, explicit
complete versioned `dependencies`, exact stable `dependencyIds`, and
`freshness` (`fresh|probably_fresh|stale|invalidated`). `params` defaults to null;
additive JSON metadata such as `result` is retained. Supplied `key`/`fingerprint`
must match canonical identity. Store revisions and `observationId` are owned by
the store. The observation and evidence register atomically. Default return is
`{observation}`; opted-in return is `{observation,evidenceRecord}`. Other observe
operations reject `evidenceRecord`.

`forge_route` and `forge_plan` optionally accept
`cacheRequest:{kind,target,dependencies,params?,risk?}`. The first three fields
are conditionally required; risk defaults to `low` (`low|medium|high`). Routing
cache lookup requires `projectId`. Fresh unchanged evidence is reusable;
probably-fresh evidence is not reused for high-risk/irreversible work. Stale,
invalidated or changed identity evidence is not reused. Higher action,
verification or decision risk cannot be bypassed by lowering query risk.

Route returns additive `evidenceRecord` (record or null). A plan hit returns
`{plan:null,evidenceRecord,efficiencyDecision:'reuse'}`; a miss returns
`{plan,evidenceRecord:null}`. Goal actionability and input validation still apply.
A hit records exactly one store-observed reuse event, not inferred avoided
calls or savings; therefore route cache retrieval is not idempotent. Completion
stop takes precedence over a route reuse recommendation.

### Plans, verification and failures

`forge_plan` optionally accepts `strategyKey`, `newEvidenceIds`,
`changedConditions`, `verificationRisk`, `expectedDecisionImpact`,
`efficiencyPolicy`, `completedCycles`, `budgetOverride` and `cacheRequest`.
Null/omitted strategy and condition markers mean no marker; evidence IDs are
trimmed and filtered. Verification risk inherits plan risk and expected decision
impact defaults to medium (`low|medium|high`). `verificationStrength` is a
derived output, not a caller override. Irreversibility preserves its risk floor.

Existing `forge_evaluate` fields `planId`, `outcome`, `summary`, `evidenceIds`
populate failure memory for keyed falsified/blocked plans. Repeating a failed
strategy requires evidence or a condition marker absent from all failed attempts.
These markers are caller assertions; failed strategies and risk floors persist.

Plan policy defaults to stored policy; cycle position defaults to last reported
routing position. Profile defaults to last route or standard. At/above the soft
budget, `MODERATE|HIGH|VERY HIGH` plans require
`budgetOverride:{category,justification}` before additional expensive work.
`MINIMAL|LOW`, including the legacy LOW default, remain cheap probes; classify
cost honestly. Categories are `unmet_success_criterion`, `important_uncertainty`,
`high_risk_verification`, `contradictory_evidence`, `blocked_goal`,
`new_evidence_requires_replan`. Justification must be concrete, nonempty and more
than the category label; unsupported override fields reject.

```json
{
  "projectId": "release",
  "action": "Verify the changed archive from a fresh extraction",
  "why": "The previous result predates the packaging change",
  "usageImpact": "MODERATE",
  "completedCycles": 3,
  "budgetOverride": {
    "category": "unmet_success_criterion",
    "justification": "The changed archive has not passed extraction tests."
  }
}
```

The persisted override adds policy, cycle position, budget and reported plan
provenance. A justified over-budget plan records one store-observed
`softBudgetOverrides` event atomically before external execution. Below-budget
rationales persist without counting overrides. Plans never count as executions.

### Progressive context and recovery

`forge_context` optionally accepts `resultLevel` (`summary|relevant|full`) and
`sinceRevision` (nonnegative safe integer no greater than current revision).
Either opts into `{context}` with `detail`, `resultLevel`, and `revision`.
Without them, existing summary/working/full contracts and `{recovery}` remain.

Summary compacts stable facts, active goals, unresolved claims, verified lessons,
recent evaluations/changes, latest checkpoint, consolidation and archive references.
Relevant adds usage and efficiency guidance, ledger, recent cache/failure records;
existing `maxItems` bounds those recent arrays (default 5, clamped 1..20).
Raw details remain recoverable rather than deleted.

A revision cursor returns untruncated `changes` for goalGraph, claims,
observations, hypotheses, experiments, lessons, plans, evaluations, adaptations,
checkpoints, transferCandidates, evidenceCache, failedStrategies, events and
consolidation. Updated records are included; legacy unstamped records are
revision zero. No changes returns empty groups. Stable decision context and
archive references remain; redundant recent-history slices are omitted.
`maxItems` never truncates deltas.

Cursor default level is summary, or relevant with working detail. An explicit
level overrides summary/working detail. Full/recovery detail requires full
result level; **any full/recovery output rejects `sinceRevision`**. Full result
returns the raw project/revision. For raw recovery use
`{detail:'recovery',resultLevel:'full'}` without a cursor. Omit an invalid/future
cursor to recover. Context reads are read-only and never increment counters.

### Optional adaptation operations and ledger

`forge_adapt` adds these optional operation choices. Associated arguments are
conditionally required only when selecting the corresponding operation:

| Operation | Data | Return |
| --- | --- | --- |
| `set_efficiency_policy` | `efficiencyPolicy` | `{efficiency}` |
| `invalidate_evidence` | `changedDependencyIds` array | `{evidenceCache}` |
| `record_efficiency_event` | `eventType`, reported `provenance`, optional counter `amount` or required stop `reason` | `{ledger}` |

Invalidation affects exact matching stable dependencies, marks them stale and
leaves unaffected records unchanged; already-invalidated records remain invalidated.

Counter event types: `usefulCycles`, `avoidedCycles`, `reusedEvidence`,
`duplicateToolCallsAvoided`, `contextsCompacted`, `reasoningEscalations`,
`softBudgetOverrides`. Optional `amount` defaults to 1 and must be a nonnegative
safe integer (zero allowed; overflow rejects). Event type `stop` requires
`reason` and disallows amount; counters disallow reason. Every reported event
requires `provenance:{source:'reported',reference:'<nonempty evidence reference>'}`.
Unsupported telemetry/fields, caller revisions, store provenance and fields on
inapplicable operations reject before mutation. Aggregate counters include
reported events; inspect `ledger.events` provenance to distinguish them from
store-observed reuse and plan overrides. Recommendations/context reads never
manufacture usage, token, cache-hit, billing or savings measurements.

## Usage impact

`MINIMAL`, `LOW`, `MODERATE`, `HIGH`, and `VERY HIGH` are qualitative workflow labels. They are not exact token, compute, or price measurements.
