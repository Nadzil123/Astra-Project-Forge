# Astra Project Forge 2.6.2 — MCP Tools

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

## Optional model routing negotiation

The pilot is off by default. An operator may enable it at server startup with
`ASTRA_FORGE_MODEL_ROUTING=advisory-v1`. Only then does `initialize` include:

```json
{"capabilities":{"tools":{"listChanged":false},"experimental":{"modelRouting":{"version":1,"mode":"advisory-v1"}}}}
```

This is a capabilities excerpt, not the entire initialization response. The
enabled `forge_route` input schema adds optional `modelRouting`; its existing
required input remains `complexity`. All nine `forge_*` and ten `adaptive_*`
tools remain available. `adaptive_route_task` is unchanged. Off mode preserves
the legacy initialization and tool catalog exactly. Omitted routing metadata
uses the legacy route even when the pilot is on. Explicit metadata while off
returns a disabled-feature error before input validation or state writes.

Clients should check both the experimental version/mode and the `forge_route`
schema before sending metadata. If either is absent or unsupported, omit the
envelope and use the legacy route. Remember this negotiation for that connection;
do not repeatedly retry an unsupported envelope against an older server.

Eligibility is independent: `ASTRA_REQUIRED_MODEL` and `ASTRA_ALLOWED_MODELS`
control the operator policy. The reviewed default permits only `gpt-6.1-sol`.
Enabling advice does not authorize Astra or expand access. An operator can
explicitly allow another model through those existing settings. Caller metadata,
reported current model, preferences, and host claims cannot grant permission.
`hostCapabilities` still accepts only its three existing boolean fields
(`deferredDiscovery`, `allowedSubset`, `discoveryAvailable`); model authority
does not belong in that envelope.

Example `forge_route` arguments for projectless advice:

```json
{
  "complexity":"moderate",
  "modelRouting":{
    "version":1,
    "workUnitId":"parser-contract",
    "sourceIdentity":"source:reviewed-tree-v1",
    "currentModel":"gpt-6.1-sol",
    "userPreference":"auto",
    "forbiddenModels":[],
    "benefit":null,
    "nextHypothesis":null,
    "stableBoundary":false,
    "receiverCanResolveReferences":true
  }
}
```

The response retains the legacy route/notices and adds `modelAdvice`. A routine
Sol report produces `action:"KEEP_SOL"`, `policyAction:"KEEP_SOL"`, and
`recommendedModel:"gpt-6.1-sol"`. Advice includes reasons, unmet criteria,
reference provenance, `verificationPreserved:true`, `advisory:true`,
`executionStatus:"not_attempted"`, `observedModel:null`,
`remainingVerifiedCost:null`, and `calibration:"not_measured"`.
Projectless `assessmentSource` is `unknown`; persisted criteria and source-bound
verification are unavailable. Projectless advice never recommends completion
or establishes a reference-dependent escalation benefit. `operationId` and
`expectedState` are forbidden without a project.

For a stateful call, add `projectId` alongside `complexity` and add the following
fields inside `modelRouting`, using the current full-state identity:

```json
{"operationId":"route-parser-1","expectedState":{"projectId":"parser","epoch":"<current epoch>","revision":12}}
```

The store commits workflow routing and advice atomically and returns historical
`identity`, `replayed:false`, and optional `modelHandoff`. The envelope rejects
unknown fields, unsupported versions, unsafe revisions, and malformed references
before mutation. Direct opt-in calls also require the complete arguments to be
JSON data; getters are rejected without execution. Source identity and persisted
assessments remain reported provenance. Only actual supported `COMPLETE` advice
can authorize the legacy positive completion flags. Negative workflow reports
and unmet verification remain visible in full, summary, and capsule projections.

When a fresh eligible non-null destination requires a change from the reported
model, the manual adapter may add a separate `handoffRequest`, for example:

```json
{"status":"user_action_required","requestedModel":"gpt-6-astra","capsule":null,"persistedContextStatus":"unavailable","switched":false,"observedModel":null,"executionStatus":"not_attempted","availability":"unknown","quota":"unknown"}
```

This example requires explicit Astra eligibility; it is not the default policy.
A stateful handoff supplies `modelHandoff` as its capsule. A matching reported
model or a generic null-destination choice does not prepare a handoff. The adapter
cannot switch models, control effort, establish trusted active-model identity,
or observe provider availability, quota, or usage.

Retry the identical semantic request with the same operation ID to read its
historical receipt without a new write. Response-only `resultLevel`,
`includeContext`, and legacy `hostCapabilities` may change on retry. Historical
advice, policy provenance, handoff capsule, and identity retain their original
meaning under changed operator policy; replay never prepares a fresh handoff.
Replay with `includeContext:true` or `resultLevel:"capsule"` separately returns
`currentDecisionCapsule`. It does not rewrite the receipt as current authorization.
Revision/epoch conflicts return the current identity and full-context resync
guidance; reassess before submitting a new operation.

Turning the pilot off restores legacy routing and keeps saved projects, evidence,
receipts, full/recovery reads, reference expansion, and adaptive compatibility
tools reachable. No provider session or automatic host control is involved.

For interruption, read recovery plus current full/reference context first.
Recovery is selective; full state retains all original constraints, older
counter-evidence, failures, registered unmet checks and epoch/revision. A new
operationId must use the reconciled current expectedState; changing semantic
input (including reported currentModel) is not an identical replay. Source-only
evidence is not invalidated merely by a different reported model. Incomplete or
stale references require resync, never guessed completion.

All four efficiency policies permit useful MODERATE verification beyond their
standard soft budget with a concrete inline `forge_plan.budgetOverride`, such as
`{category:'unmet_success_criterion',justification:'The resumed source still lacks
the mandatory dependency-contract regression result; verify it before satisfying
the registered criterion.'}`. No extra governor call is needed. Plans/advice do
not increment executed-cycle counters; retain usage-notice acknowledgements and
honest cost labels. Internal `maximum` is not an API effort or host Ultra mode.

See the [pilot operator guide](MODEL-ROUTING-PILOT.md) for the two independent
opt-ins, manual resume and narrow-policy/off rollback without erasure. Both
explicitly eligible models retain the full capability ceiling and all 19 tools.
The [version-1 offline evaluation contract](MODEL-ROUTING-EVALUATION.md) defines
the actual four-arm draft campaign, supplied-trace reporter and self-test commands.
Empirical comparison is `not_run`, missing telemetry stays `null`, and protocol
validation/synthetic results authorize no live campaign, spending or release.

## Usage impact

`MINIMAL`, `LOW`, `MODERATE`, `HIGH`, and `VERY HIGH` are qualitative workflow labels. They are not exact token, compute, or price measurements.

## Optional v2.6.2 coordination and capsules

These modes are explicit opt-ins. All 19 names, legacy required fields, omitted
options, and existing `summary`/`full` projections remain available. Capsules
use heuristic selection; their effect on model decision quality is unmeasured.
They do not guarantee smaller responses or semantically complete context.

### Read decision context and expand records

```json
{"projectId":"release","resultLevel":"capsule","goalId":"goal-root","maxItems":5}
```

`forge_context` returns `{context}` containing `identity:{projectId,epoch,revision}`,
the selected goal, constraints, unmet criteria, epistemic claims and their evidence
pointers, blockers, uncertainty, risk, failed strategies, changed evidence,
completion, and `refs`. Optional `cursor:{projectId,epoch,revision}` bounds changes
without hiding unchanged mandatory safety information. Optional `knownRefs` returns
pointer/status metadata without full bodies. An invalid cursor produces
`expansion.resync`; truncation or unavailable data sets `incomplete:true` and supplies
expansion pointers. Neither flag proves completion or failure.

Expand a returned pointer through `forge_context`:

```json
{"projectId":"release","references":[{"projectId":"release","epoch":"<returned epoch>","kind":"evaluation","id":"<returned id>","revision":12}]}
```

This is an explicit full-record read, returning `{context:{identity,references}}`.
Optional `resultLevel:"full"` is equivalent to omission. Use it without other
context selection, cursor, `knownRefs` or goal selection.
Exact available revisions return `unchanged` plus `record`/`ref`; omitted record
revision requests `current`. Stale versions return `currentRecord`/`currentRef`,
never a new record labeled as the old revision. Missing or cross-generation refs
give status and resynchronization guidance. Evidence refs use cache keys, rather
than caller evidence IDs. A pointer certifies identity, not truth or freshness.

Capsule reads reject `sinceRevision` and `detail:full|recovery`. Capsule-only
`goalId`, `cursor` and `knownRefs` reject other result levels. Direct full state is
always available through `forge_context:{projectId,detail:"full"}` or
`{projectId,detail:"recovery",resultLevel:"full"}`; no budget override is needed.

### Control responses and one-call routing context

`forge_route`, `forge_plan`, `forge_observe` and `forge_evaluate` also accept
`resultLevel:"capsule"`. This applies the existing summary omissions to record
acknowledgements and adds `decisionCapsule`; safety fields, missing criteria,
completion reasons and errors survive. Stored records remain complete. A fused
evaluation instead labels newly read context `currentDecisionCapsule`, keeping
its historical response identity and completion distinct.

```json
{"projectId":"release","complexity":"complex","includeContext":true,"resultLevel":"summary"}
```

`forge_route.includeContext:true` adds a decision capsule in one MCP call,
independently of result level. This current snapshot is read after the route
commit and may include later concurrent updates. Without `projectId`, routing
remains stateless: requested context is `decisionCapsule:null` with a
`contextUnavailable` explanation. Projectless capsule output retains the entire
route and creates no persisted reference.

### Atomic reported evaluation

`forge_evaluate.coordination` conditionally requires `operationId`,
`stateEpoch` and `expectedRevision`. Optional `evidenceRecords`,
`changedDependencyIds`, `criteriaUpdates`, `claimUpdates` and `efficiencyEvents`
join the evaluation in one atomic commit. Omission keeps the legacy evaluation
path, without implicit goal or claim promotion.

When both are supplied, `changedDependencyIds` invalidates the previously cached
evidence before `evidenceRecords` registers the newly reported results. This
allows fresh evidence for the changed source to support explicit criteria and
claim updates in the same transaction. Incoming stale evidence remains stale;
invalidation does not by itself establish freshness or satisfy any criterion.

```json
{
  "projectId":"release",
  "outcome":"verified",
  "summary":"Tests reported passing",
  "evidenceIds":["tests-1"],
  "resultLevel":"capsule",
  "coordination":{
    "operationId":"release-tests-1",
    "stateEpoch":"<returned epoch>",
    "expectedRevision":12,
    "evidenceRecords":[{"evidenceId":"tests-1","kind":"test","target":"release","dependencies":["release:v1"],"dependencyIds":["release"],"freshness":"fresh","result":{"passed":true}}],
    "criteriaUpdates":[{"goalId":"goal-root","criterion":"tests pass","satisfied":true,"evidenceIds":["tests-1"]}]
  }
}
```

Criteria must match registered declarations. Claim updates name `claimId` and
may explicitly update `statement`, `status`, `confidence`, `evidenceIds` and
`counterEvidenceIds`; `verified` alone never makes a claim known. Efficiency
events use the existing reported provenance envelope. Entire proposals validate
before persistence; invalid updates roll back together.

The response adds `identity`, `completion`, `changed`, `refs` and `replayed`.
Completion is a structural assessment of reported evidence, explicitly
`assessmentSource:"reported"`, not independent semantic verification. Unmet
criteria, blockers, contradictions, unknowns and unresolved risk veto completion.

Known claims require assessment pins for their statement and exact evidence content
and version. Pins live in additive `coordination.claimAssessments` metadata. An
explicit `status:"known"` or `evidenceIds` update assesses the current support;
confidence-only, statement-only or unrelated writes do not. Replacing or
invalidating evidence revokes current completion even if separate criterion
support remains fresh. Restoring old content requires reassessment too. Legacy
claim writes still accept external evidence IDs, but absent, ambiguous, stale or
unpinned support cannot certify current completion. Evidence result fields are
not interpreted as truth. Historical operation receipts remain unchanged.

Evaluation blockers and uncertainty use the latest assessment within the applicable
goal, resolving `planId` through its associated goal. An unrelated goal cannot
clear a failure; a corrected plan for the same goal can. A plan without a goal can
supersede only itself, and a bare evaluation in a one-goal project has one possible
goal scope. Conflicting goal/plan associations or multi-goal unscoped evaluations
remain conservative until an explicit project reassessment.

A **new fused verified evaluation** receives `evaluation.assessmentScope:"project"`
only when it has no `missingCriteria` and that request explicitly maps every
registered criterion of every current goal to `satisfied:true` with fresh, valid
support. Every goal must have nonempty declared criteria. Existing assessments,
partial mappings or a bare verified outcome do not qualify. This is a reported
project reassessment, not independent truth verification. In chronological order
it supersedes earlier ambiguous/unassociated evaluation results only; scoped goal
failures and claim, risk, checkpoint or hypothesis blockers still apply. Replaying
that operation cannot clear newer failures or mutate its historical receipt.

After response loss, retry the identical semantic payload and operation ID,
including its original epoch/revision. A committed request replays once without
another write, even after later commits. `resultLevel` may vary on retries;
evaluation/coordination payload changes with the same ID fail. A new operation
with an old revision or epoch conflicts. The error preserves its legacy
`content:[{type:"text",text:...}]` and `isError:true` wrapper and adds
`structuredContent:{code,identity,resync}`. `code` is `REVISION_CONFLICT` or
`STATE_EPOCH_CONFLICT`; `identity` is the current `{projectId,epoch,revision}`.
`resync.fullContext` supplies `{tool:"forge_context",arguments:{projectId,detail:"full"}}`
and `resync.action` instructs the caller to reassess the proposal. Ordinary legacy
errors retain their previous shape. Conflict rejection changes no persisted
bytes. Read current context and reconcile the proposal before submitting a new
operation ID; no automatic retry or semantic merge occurs. Replay identity/completion remain
historical; `currentDecisionCapsule`, when requested, has its own current identity
and completion. It must never be substituted for the historical response.

### Advisory host capability selection

```json
{"complexity":"complex","hostCapabilities":{"deferredDiscovery":true,"discoveryAvailable":true}}
```

Optional `forge_route.hostCapabilities` accepts only boolean `deferredDiscovery`,
`allowedSubset`, and `discoveryAvailable`. It returns `capabilitySelection` advice
with selected names, a complete stable fallback and `advisory:true`. Unknown or
unsupported support, an unsupported selection stage, or failed/unavailable
discovery uses the stable catalog. Confirmed support may suggest a temporary
subset, keeping context expansion and recovery reachable. `tools/list` always
returns the same 19 schemas and names.

This does not enable deferred loading, `tool_search`, `allowed_tools`, permissions
or prompt caching. The host adapter must provide and test those facilities;
selection changes no permissions and reports `cacheSavings:null`. Apply advice
only when actual host integration and measurements support it. Full context and
all permitted capabilities remain directly reachable.
