# Offline Four-Strategy Evaluation Contract

The four-model-strategy experiment has **not run**. The checked-in
`model-routing-campaign.json` is an unfrozen, unapproved draft with missing real
task sources, graders, artifacts, calibration and spending reviews. This pilot
validates supplied contracts, proposes assignments and reports supplied traces.
It contains no provider runner or model controller. Structural acceptance never
authorizes execution, authenticates approval or establishes comparative quality.

## Portable Commands

Run from the plugin source/package root with Node 20 or later. These commands
require neither Git nor private planning files, accounts or provider credentials:

```sh
npm run benchmark:routing:self-test
node scripts/benchmark-routing.mjs --validate-campaign docs/model-routing-campaign.json
```

The self-test uses explicitly synthetic arithmetic and a complete synthetic
16-task scheduling contract. It tests actual validators, scheduler, reporter,
pure policy, utility guard and handoff preservation; it does not execute models
or prove which strategy is better. The draft command intentionally exits 1 and
names `missing_freeze`, `missing_readiness_review`, `missing_spending_review`
and missing grader/calibration commitments. Changing only `status` cannot fix it.

For a separately supplied complete contract:

```sh
node scripts/benchmark-routing.mjs --validate-campaign /path/to/contract.json
node scripts/benchmark-routing.mjs --schedule /path/to/contract.json
node scripts/benchmark-routing.mjs --traces /path/to/supplied.jsonl --manifest /path/to/report-manifest.json
```

Each mode is exclusive; duplicate, incomplete or mixed options fail. Input paths
may be absolute and commands work from an unrelated working directory when the
script path is absolute. Successful validation/scheduling outputs explicitly say
`mode:'offline'`, `executionAuthorized:false`, `executionStatus:'not_attempted'`
and `externalReadinessVerified:false`. Error output also says execution is
unauthorized and not attempted. Input file SHA-256 digests describe supplied
bytes, not independent truth. Legacy report mode still takes both explicit files
and has no default workload.

## CampaignV1

`validateRoutingCampaign(value)` returns a detached copy or throws a named
structural/readiness error. It reads no files and makes no external calls.
There is no special synthetic skip flag. A frozen synthetic contract must pass
the same complete checks with clearly fixture-only content/review references.
Keep such contracts and outputs outside the empirical evaluation dataset.

| Field | Contract |
| --- | --- |
| `version`, `campaignId`, `status`, `provenance` | Version 1, nonempty ID, `draft` or `frozen`, explicit evidence kind/reference; draft always rejects readiness |
| `strategies` | Ordered `sol_only`, `astra_only`, `sol_first_control`, `adaptive_evidence` |
| `repetitions`, `schedulingSeed` | `[1,2,3]`, unsigned 32-bit integer used only for scheduling |
| `cacheStratumByRepetition` | Exactly `['cold','warm','cold']`, shared by all arms of each task/repetition |
| `controls` | Ten nonempty common references listed below |
| `arms` | Same ordered strategies, exact common controls and protected verification floor |
| `policy` | Frozen `{manifest:{reference,sha256},tunedOnEvaluation:false}` |
| `reviews` | Explicit `readinessReference`, `spendingReference`, `graderIndependenceReference` |
| `tasks` | Exact sixteen evaluation slot identities/categories, frozen manifests, split, criticality, content identity, independent grader and required checks |
| `calibrationTasks` | Nonempty separate records `{taskId,contentIdentity,manifest:{reference,sha256}}` |
| `freezeCommitment` | SHA-256 commitment to the entire supplied campaign except this top-level field |

Common control keys are `sourceReference`, `taskInputsReference`,
`promptReference`, `graderReference`, `policyReference`, `dependenciesReference`,
`permissionsReference`, `toolSchemaReference`, `eligibilityReference` and
`featureFlagsReference`. The corresponding records must define equal approved
eligibility, permission, tools, effort/tier conditions and verification access
for all four arms. A reference is a declaration, not proof of host access.
Eligibility and feature flags are separate controls; enabling advice never widens
the operator allowlist. Preserve the existing Sol default and every tool.

The arm fields `initialModel`/`escalation` are respectively `sol`/`never`,
`astra`/`never`, `sol`/`first_failed_verification_or_unchanged_failed_strategy`,
and `policy`/`evidence_based`. The simple control starts with one Sol work unit
then escalates on its first objectively failed verification or proposed repeat
of an unchanged failed strategy. This is a comparator declaration; it does not
add a production retry threshold. Adaptive D uses the frozen evidence-based
policy and may recommend initial Astra for a concrete useful benefit.

Every arm's `verificationFloor` is the ordered list `mandatory_criteria`,
`required_regressions`, `no_critical_false_success`, `no_new_critical_failure`.
No strategy may weaken it or silently use a different feature ablation.
Eligibility-only and capsule/fusion/deferred-tool ablations are separate studies.

## Task Freeze And External Readiness

Each task has `taskId`, `category`, `split` (`held_out` or `out_of_domain`),
`criticality` (`ordinary` or `critical`), nonempty unique `requiredChecks` IDs,
`contentIdentity` (SHA-256 of the independently defined task content), and
`frozen:{source,task,prompt,grader,artifacts}`. Each frozen part is a supplied
manifest `{reference,sha256}`. `artifacts` commits the expected artifact manifest,
not an invented successful result. Source records must pin actual snapshots,
dependencies, prompts/context and graders before a real readiness review.

Task-content identity is separate from task ID and repository snapshot. Duplicate
evaluation/calibration identities or content reject, including renamed duplicates;
a shared repository snapshot alone is allowed. Both evaluation splits must remain.
Held-out outcomes cannot tune the frozen policy within the same campaign.

Each `grader` declares `kind:'executable'|'blinded_rubric'`, `independent:true`
and `hiddenReviewReference`. Architecture slots require a blinded rubric.
Rubric graders additionally require `calibrationReviewReference` and
`humanAgreementReviewReference` to externally reviewed human-labeled agreement
and calibration records. Do not publish hidden oracle contents in campaign JSON.
These references remain reported claims. Separate external review must establish
real files, hidden graders, independence, agreement, freeze/approval authenticity,
configured runtime, model eligibility and spending limits. Neither a supplied hash,
file existence nor a self-asserted review can establish those facts here.

The draft records all sixteen discriminating acceptance requirements:

| Slots | Required independent discrimination |
| --- | --- |
| `routine-parser`, `routine-filter` | Boundary/invalid-input oracle; hidden path/type edge cases |
| `debug-span`, `debug-nested-call` | Original off-by-one and nested-argument reproductions, plus negative controls |
| `multi-manifest`, `multi-record` | Old/new clients; producer/consumer schema and unknown fields |
| `ambiguous-permission`, `ambiguous-eof` | Permission versus defect; EOF versus read boundary, without weakening tests |
| `migration-unknown`, `migration-replay` | Unknown fields/backups/rollback; lost response with concurrent writer, stale-write rejection and exactly-once outcome |
| `architecture-gate`, `architecture-layout` | Actual eligibility/host constraints; storage invariants and feasible migration, independently blinded rubric |
| `long-package`, `long-recovery` | Final package and all gates; interrupted recovery with original constraints and resource cleanup |
| `risk-corrupt`, `risk-counterevidence` | Corrupted artifact despite superficial passing check; high-impact change with older contradiction |

Easy synthetic fixtures do not substitute for these real task artifacts.

## Commitments And Scheduling

Canonical JSON uses ordinary JSON primitive encoding, array order unchanged and
object keys sorted lexicographically recursively, without whitespace. Encode as
UTF-8, hash with SHA-256 and use 64 lowercase hex characters. Exclude only the
top-level `freezeCommitment` when computing the campaign digest. A task commitment
hashes the full frozen task record. All campaign fields, including reviews,
splits, controls, policy, manifests, scheduling seed and extensions, are committed.
Changing one without recomputing its commitment rejects as `manifest_drift`.
Recomputing a digest only creates a different declaration, not external approval.

`buildRoutingSchedule(campaign)` validates through that same contract and returns
192 proposed assignments: 16 tasks x 3 repetitions x 4 arms. It preserves task and
repetition order and deterministically shuffles arm order in each paired block
using SHA-256 counter draws from `[schedulingSeed,drawIndex]` and a Fisher-Yates
shuffle. Same input/seed reproduces order. Changing seed changes order, not
membership; the seed makes no model determinism or permission claim.

There are 128 assigned-cold and 64 assigned-warm trajectories in total (32/16 per
arm). Report these small, unequal strata separately. A warm assignment proves no
provider cache hit; never fill observed `cacheState` or usage from the assignment.
An expanded cache study requires separately approved sample and spending changes.
Include observed priming/setup charges and time rather than hiding warm-up work.

Each assignment contains `campaignId,taskId,repetition,strategy`,
`assignedCacheStratum`, the offline/execution fields and `binding`. That binding
is an expected declaration for the proposed run, not observed evidence.

## Optional Campaign-Bound Reports

The two-argument `summarizeRoutingTraces(traces,manifest)` API is unchanged.
Without `manifest.routingCampaign`, Task6 reporting stays operational. With it,
the supplied frozen CampaignV1 must validate and match campaign ID, provenance
kind, task/category/criticality matrix, repetitions, strategies and controls.

For each supplied trace, `campaignBinding` has exactly:

```text
{
  campaignCommitment: SHA256,
  taskCommitment: SHA256,
  assignedCacheStratum: 'cold' | 'warm',
  manifests: { source: SHA256|null, task: SHA256|null, prompt: SHA256|null,
               grader: SHA256|null, artifacts: SHA256|null },
  requiredChecks: string[] | null,
  controls: { <each of the ten control keys>: string | null }
}
```

Root trace identity supplies task/repetition/strategy; the campaign schedule
supplies their expected commitment and assigned stratum. Bind actual reported
observations to those expectations. Do not copy expected fields into missing
observations: use null, or omit the whole binding when unavailable. A matching
binding is still supplied reported evidence, not independent attestation.
`verification.grader.reference/kind` must match the frozen grader, and every
required check must be present and pass. A negative artifact grader overrides an
agent's claimed success. Architecture grading remains externally blinded.

Malformed binding shapes reject clearly. Well-formed drift, unknown controls,
missing observations, quota/error/unavailable outcomes and failed recovery remain
in trajectories, paired outcomes, costs and coverage rather than disappearing.
Each evidence-kind assessment additionally has `protocol` with `issues`,
`observedSwitches`, per-class coverage/failures, assigned `cacheStrata`, missing
usage count, and status `violation`, `failed`, `inconclusive` or
`consistent_observations`. An earlier failed attempt recovered by a later
independently verified completion remains an operational record and cost; an
unresolved final failure or missing required recovery observation is inconclusive.
Failed recovery is a failure. Missing destination observations never count as an
observed switch. Requested/recommended/current-reported model names do not prove
execution. Keep actual effort/tier/fingerprint/cache/usage observations separate.

Protocol consistency is necessary for a campaign-bound protected floor. Unknown
or drifting bindings suppress its unit-cost claim (`protocol_not_satisfied`)
while retaining known resource subtotals. Cache-stratum cost rows are known
subtotals only, not claims of all-in coverage. Grading, failed requests, tools,
reviews, setup, handoffs, recovery and reruns still belong in resource coverage;
missing charges stay unknown, not zero. No bytes-to-tokens conversion, rate lookup
or conversion among API money, credits and included subscriptions occurs.

## Interpretation And Rollback

Select `report.assessments` by trajectory `evidenceKind`. For mixed kinds,
`summaryEvidenceKind`, top-level `cohort` and `quality` are null; single-kind
aliases remain. A charge-only estimate does not create an extra cohort. Missing
manifest-kind runs remain incomplete. A critical failure, false success or failed
regression vetoes all strategies within that kind; foreign-kind evidence cannot
fill its blocks or veto another kind. Raw artifact verification and paired
outcomes are reported facts, not proof that campaign controls were satisfied.

The protocol retains all eight falsification groups: hidden migration invariant;
difficult wording/cheap exact check; paraphrase without new evidence; useful
verification beyond soft budget with justification; forbidden/unavailable Astra;
older contradiction/stale ref/same-ID replacement; warmed-prefix/schema change;
and repeated capsule expansion/storage inflation. Harness passes demonstrate
guardrails and accounting only, never comparative Sol/Astra quality or a D win.

Report per-class/per-model counts, paired outcomes, coverage, failed runs and
worst cases before cost per verified result. Preserve missing telemetry as null.
Ordinary non-inferiority stays `unresolved_pending_preregistration`: the owner
must pre-register a margin and paired analysis after pilot variance is known;
the conservative proposal permits no degradation. Sample adequacy stays
`inconclusive`; cluster repetitions by task, do not manufacture p-values or
reliable p95/p99 from three repetitions. Zero observed critical false success
and no new critical failures relative to Astra are required, not proof of zero
risk. Savings targets are not acceptance criteria. `efficiencyClaimAllowed`
remains false, `empiricalSavings` null, and no default change is authorized.

Rollback retains all imported raw traces, artifacts, provenance, failed attempts
and contradictory results. Reruns keep separate identities and their costs; they
do not multiply verified task/repetition results. Never delete failures to improve
averages. Actual empirical execution and any expanded sample require a separate
external readiness and spending decision.
