# Advisory Model Routing Pilot

This source pilot adds optional advice to `forge_route`. The operator default is
`gpt-6.1-sol`, with advice off. It retains package version 2.6.2, schemaVersion 2,
AGPL-3.0-only and the existing nine `forge_*` and ten `adaptive_*` tools. This is
not a new release or an update to an installed plugin.

Empirical model comparison is **`not_run`**. The checked-in campaign is a draft;
offline validation and synthetic self-tests authorize no model execution,
spending, default rollout or publication.

## Two Independent Operator Opt-Ins

| Startup configuration | Eligible models | Advice |
| --- | --- | --- |
| No model settings | Sol only | Off |
| `ASTRA_ALLOWED_MODELS=gpt-6.1-sol,gpt-6-astra` | Sol and Astra | Off |
| `ASTRA_FORGE_MODEL_ROUTING=advisory-v1` | Sol only | On |
| Both settings | Sol and Astra | On |

`ASTRA_REQUIRED_MODEL` defaults to `gpt-6.1-sol` and remains eligible even when an
additional allowlist is supplied. Models are trimmed/lowercased/deduplicated;
empty/unknown identities are ineligible. To select an explicit Astra-only policy,
set required model to `gpt-6-astra` and remove additional allowed models. Installing
the source or requesting advice never enables Astra eligibility.

Example process-local launch, after the operator chooses both opt-ins:

```sh
ASTRA_REQUIRED_MODEL=gpt-6.1-sol \
ASTRA_ALLOWED_MODELS=gpt-6.1-sol,gpt-6-astra \
ASTRA_FORGE_MODEL_ROUTING=advisory-v1 \
ASTRA_PROJECT_FORGE_DATA_DIR=/absolute/path/to/project-state \
node /absolute/path/to/astra-project-forge/server/mcp-server.mjs --stdio
```

These assignments affect that process; they do not edit host/global settings.
An absolute entrypoint works from an unrelated working directory, including paths
with spaces/special characters. Quote paths containing spaces. Configuration is
read at startup: restart the relevant server/hook processes after an operator
change. Routing mode accepts only unset/`off` or `advisory-v1`; other values fail.

The hook checks the host-reported top-level model independently of routing mode.
Tool arguments cannot widen that policy. The lifecycle hook is not MCP
authentication; direct stdio does not enforce host model authorization.

## Negotiation And Legacy Fallback

Send `initialize`, then `notifications/initialized`, and discover `tools/list`.
Only enabled startup advertises
`capabilities.experimental.modelRouting={version:1,mode:'advisory-v1'}` and the
optional `forge_route.inputSchema.properties.modelRouting`. Check both before
sending the envelope. If either is absent/unsupported, omit it and use the legacy
route. Remember negotiation for that connection instead of retrying unsupported
metadata. `adaptive_route_task` is unchanged.

Omitted metadata uses legacy behavior even on an enabled server. Off mode keeps
the legacy initialization/catalog schema; explicit routing metadata receives a
disabled-feature error before validation or state mutation. No new tool is added.
See [the exact envelope and projections](TOOLS.md#optional-model-routing-negotiation).

## Capability Ceiling And Host Limits

Both explicitly eligible models retain the full Forge capability ceiling,
including goals, plans, observations, evaluation, adaptation, checkpoints,
consolidation, legacy compatibility, full/recovery reads and reference expansion.
All specialized capabilities remain available when the host exposes and permits
them. Advice does not remove tools or grant account/model/execution permissions.

The bundled `manual-v1` adapter cannot select the active turn model or host effort.
Trusted identity, subagent model selection, discovery/deferred loading and usage
telemetry are unknown. Legacy `hostCapabilities` remains its three-boolean
advisory contract, not model authority or an implemented deferred loader.
Workflow depth, efficiency policy, model advice and actual host effort are
separate controls. Internal `maximum` is not an API effort or host Ultra setting.

`currentModel`, `sourceIdentity`, persisted criterion assessments and matching
trace bindings remain reported provenance. A reported model is not a trusted
observation. Advice reports `advisory:true`, `verificationPreserved:true`,
`observedModel:null`, `executionStatus:'not_attempted'`,
`remainingVerifiedCost:null` and `calibration:'not_measured'`.

## Request, Interrupt And Resume

Initialize a project with its original constraints and mandatory success criteria.
Use the existing goal/plan/observe/evaluate tools to register evidence,
contradictions, failed strategies and the concrete next action. Read
`adaptive_get_state` or `forge_context` full output for the current coordination
epoch and revision before a stateful routing operation. Reference revisions are
the records' own revisions, not a guessed current project revision.

Illustrative routing arguments, using identities from those current reads:

```json
{
  "projectId":"dependency-contract",
  "complexity":"moderate",
  "modelRouting":{
    "version":1,
    "workUnitId":"consumer-contract",
    "sourceIdentity":"source:<the source snapshot being verified>",
    "currentModel":"gpt-6.1-sol",
    "userPreference":"auto",
    "forbiddenModels":[],
    "benefit":{
      "kind":"dependency_risk",
      "reason":"Resolve which dependency contract preserves consumers before changing them",
      "refs":[{"projectId":"dependency-contract","epoch":"<current epoch>","kind":"plan","id":"<unresolved high-impact plan id>","revision":11}]
    },
    "nextHypothesis":null,
    "stableBoundary":false,
    "receiverCanResolveReferences":false,
    "operationId":"route-consumer-1",
    "expectedState":{"projectId":"dependency-contract","epoch":"<current epoch>","revision":12}
  }
}
```

Replace the illustrative IDs and revisions with actual values. A current,
unresolved high-impact dependency plan can justify initial Astra advice. A hard
sounding task or repeated failure count alone cannot. User preferences and
forbidden models may restrict recommendations, never widen operator eligibility.

A fresh eligible transition can return substantive `policyAction:'ESCALATE_ASTRA'`
with manual `action:'REQUEST_USER_CHOICE'`. Its separate `handoffRequest` has
`status:'user_action_required'`, `switched:false`, `observedModel:null`,
`executionStatus:'not_attempted'`, availability/quota unknown. A projectless
request has no persisted identity/operation and uses a null handoff capsule with
`persistedContextStatus:'unavailable'`. Projectless advice cannot establish
completion or a reference-dependent escalation benefit.

For a persisted project, `modelHandoff` retains original constraints, unmet
checks, counter-evidence, contradictions, failed strategies, required
verification, source/model provenance and epoch/revision. A receiver without
reference access gets `referenceBodies`. A capsule may be incomplete; follow its
resync instructions and expand full/reference context rather than assuming the
omitted history is irrelevant.

After interruption or an operator's manual model selection:

1. Read `forge_context:{projectId,detail:'recovery'}` and full context with
   `{projectId,detail:'full'}`. Recovery is selective; full state retains older
   constraints/evidence and the current identity. Neither needs an efficiency
   override. Do not combine full/recovery reads with delta cursors.
2. To recover a lost response, replay the identical semantic request and
   operationId. The receipt keeps its historical identity/advice/policy/handoff
   and writes nothing. Response-only `resultLevel`, `includeContext` and legacy
   `hostCapabilities` can change. No fresh handoff is authorized by replay.
3. `includeContext:true` or capsule projection on replay returns a separately
   labeled `currentDecisionCapsule`, which may include an intervening writer's
   newer revision. Historical advice is not a current completion or policy grant.
4. Reconcile current constraints, refs, source and operator policy. New operations
   with stale revision/epoch fail with current identity and full-context resync;
   reassess instead of automatically retrying a stale proposal.
5. Use a new operationId/current expectedState for a changed request, including a
   new reported currentModel after manual selection. This still does not observe
   execution. An unresolved same-source trigger may hold Astra even when a caller
   reports a stable boundary. Preserve source-only evidence across model reports;
   revalidate only evidence whose exact dependencies changed.

No acknowledgement can turn a requested switch into an observed one. Completion
requires supported mandatory criteria bound to the requested source, with no
important contradiction or meaningful risk. Optimistic caller flags cannot
establish it. Retain falsified/blocked attempts and unmet checks on every resume.

## Useful Work Beyond A Soft Budget

The existing general/deep Usage & Cost Notice and acknowledgement rules still
apply. `eco`, `balanced`, `performance`, and `maximum` budgets guide useful work;
they do not force completion or remove verification. Plans with `MODERATE`,
`HIGH` or `VERY HIGH` usage at/above the soft budget require a concrete inline
override, for example:

```json
{
  "projectId":"dependency-contract",
  "goalId":"goal-root",
  "action":"Verify the dependency contract against the resumed source",
  "why":"Resolve the mandatory consumer regression",
  "usageImpact":"MODERATE",
  "budgetOverride":{
    "category":"unmet_success_criterion",
    "justification":"The resumed source snapshot still lacks the mandatory dependency-contract regression result; verify that contract before satisfying the registered criterion."
  }
}
```

No extra governor call is needed. Report cost/cycle position honestly; the LOW
cheap-probe default must not disguise expensive work. A recorded plan is not an
executed cycle or proof of success. Repeated unchanged failures require new
evidence or materially changed conditions.

## Offline Evaluation And Accounting

Use the [final version-1 evaluation contract](MODEL-ROUTING-EVALUATION.md) for the
actual fields and frozen-manifest requirements. The four arms are `sol_only`,
`astra_only`, `sol_first_control` and `adaptive_evidence`. Sixteen task slots,
three repetitions and four arms yield 192 proposed assignments, not executions.
The simple control's first-failed-verification trigger is a comparator, not a
production retry rule. Every arm retains the same eligibility, tools, permissions
and mandatory verification floor.

For campaign-bound attempts, the exact pilot models are `gpt-6.1-sol` and
`gpt-6-astra`. Explicit unsupported requested/observed models are protocol
violations on any attempt. Unknown `observedModel:null` is inconclusive. Count
switches only between supported observed endpoints with the matching requested
destination; a requested switch alone proves none. A negative independent
artifact grader overrides claimed success. Failed recovery, quota/errors,
unavailable models and missing observations remain recorded outcomes/costs.

Run these offline commands from the plugin root with Node 20+; no install, Git,
SDD state, account or credential is needed:

```sh
npm run benchmark:routing:self-test
node scripts/benchmark-routing.mjs --validate-campaign docs/model-routing-campaign.json
node scripts/benchmark-routing.mjs --schedule /path/to/complete-frozen-contract.json
node scripts/benchmark-routing.mjs --traces /path/to/supplied.jsonl --manifest /path/to/report-manifest.json
```

The self-test is explicitly synthetic. The checked-in draft validation is
expected to exit 1 for missing freeze/readiness/spending and grader/calibration
commitments. Successful scheduling/validation still reports `mode:'offline'`,
`executionAuthorized:false`, `executionStatus:'not_attempted'` and
`externalReadinessVerified:false`. Hashes bind supplied bytes, not approval truth.
The reporter reads supplied traces; it has no provider runner or default workload.

Retain setup/priming, all attempts and reruns (including failures), tools,
coordination, grading/reviews, handoffs and recovery in total resources and cost
coverage. Known subtotals are not all-in totals. Missing telemetry stays `null`,
never zero. Context bytes are part of response bytes; reasoning/cache categories
may overlap provider token totals. Respect explicit subset/charge coverage and
do not double count. Actual model/effort/tier/fingerprint/cache observations stay
separate from assignments. API money, product credits and included subscriptions
are separate accounting systems; do not convert bytes to tokens, look up assumed
rates or apply API prices to subscription usage.

Report quality, failures, paired outcomes, class/model coverage and worst cases
before cost per verified result. Ordinary non-inferiority is
`unresolved_pending_preregistration`, sample adequacy is `inconclusive`,
`efficiencyClaimAllowed` remains false and `empiricalSavings` null. Deterministic
dispatch/byte/storage checks do not establish model-quality or cost savings.
Research/plan approval is separate from live runtime/access/spending approval;
default/release actions also require their own authorized decision.

## Rollback Without Erasure

Set advice to `off` or remove its setting and restart, keeping the same data
directory. Restore the operator's saved eligibility settings separately. For an
explicit Astra-only fixture, set `ASTRA_REQUIRED_MODEL=gpt-6-astra` and remove the
extra allowlist; this is not the shipped Sol default. Narrowing eligibility while
advice is on also does not erase historical receipts or authorize their old
destinations under the new policy.

Full/recovery/reference and adaptive reads stay reachable; legacy writes preserve
the optional routing extension, project identity/epoch, evidence and unknown
fields. An unsupported future extension remains intact under legacy paths while
new routing writes reject it. Do not delete state, rewrite historical identity,
discard failed trajectories or clear counter-evidence to roll back. Keep raw
campaign traces/artifacts and separate rerun identities/costs. This source change
does not install, publish or release a plugin.
