# Astra Project Forge v2.6.2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve Forge capabilities while reducing redundant coordination through opt-in atomic evaluation, decision capsules, references, and measured host advice.

**Architecture:** Keep the 19-tool public surface and existing defaults. Serialize all project read-modify-write operations, then build opt-in coordination transactions and state projections over the existing engine. Benchmark against the exact uploaded v2.6.1 snapshot and leave model-quality claims unmeasured unless actual model runs exist.

**Tech Stack:** Node.js >=20, ES modules, node:test, standard library, stdio MCP, JSON state; no new runtime dependency.

**Spec:** `docs/DESIGN-v2.6.2.md` (user approved 7 October 2026).

All paths below are relative to `plugins/astra-project-forge/` in the isolated worktree.

## Global Constraints

- Preserve all 9 `forge_*` and 10 `adaptive_*` tools, legacy required inputs, response wrappers, existing output fields and default semantics. New behavior is opt-in; full state may include additive coordination metadata.
- Preserve AGPL-3.0-only, LICENSE, NOTICE.md and ATTRIBUTION.md bytes.
- Useful computation is not waste. Soft budgets never justify false completion or block the existing justified override path.
- Never fabricate model turns/tokens, cache hits, costs, or model quality; unavailable telemetry is null.
- Keep old regression tests and immutable fixtures. Current version assertions may advance to 2.6.2 with release metadata; current schema assertions may include explicitly approved optional additions. Preserve legacy behavioral assertions and all frozen versions/hashes.
- Every implementation task uses RED → GREEN tests and one full regression run before its completion. Review is controller-owned; workers never spawn agents.
- No push, merge, publish, or edits to the baseline branch. Commit only in feature/coordination-v262.

## Review Focus

1. Two processes, symlink aliases, or a migration read racing a mutation must not lose updates (Task 1).
2. Response loss followed by retry with an old expected revision must replay once, while changed payload with the same ID must fail (Task 2).
3. An unchanged hard constraint, old counter-evidence, or reset cursor must remain visible rather than falsely disappearing in a delta (Task 3).
4. An unsupported host, malformed optional request, or projectless route must retain legacy behavior and permitted capability access (Task 4).
5. Baseline source/fixtures, accounting subsets, and packaging must prevent an apparent win from changing the workload or double-counting bytes (Task 5).

## Task 1: Serialized and durable project persistence

**Files:** Create `server/project-persistence.mjs`, `tests/v262-persistence.test.mjs`, process test helpers under `tests/helpers/`; modify `server/state-store.mjs`.

**Interfaces:**
- Keep `new ProjectStore(rootDir)` and every current method callable with current inputs.
- Export `withProjectLock(filePath, asyncWork)` and `atomicWriteJSON(filePath, value)` from project-persistence.
- Add `ProjectStore.transact(projectId, update)`; update synchronously mutates the loaded project and returns a result. Return `{ project, result }` after one persisted revision. A thrown callback or invalid asynchronous callback commits nothing.
- All legacy mutation methods, reinitialization, and migration writes participate in the same per-project critical section. Nested store operations must not deadlock. Atomic reads may observe the prior or next whole snapshot.

- [ ] Write tests before implementation: concurrent observations across store instances and child processes preserve every observation and monotonically advance revisions; migration cannot overwrite a simultaneous mutation; a throwing transaction changes no file bytes; transactions commit one revision; reentrant calls do not hang; aliases of the same directory serialize.
- [ ] Run `node --test tests/v262-persistence.test.mjs`; capture the expected pre-implementation failures.
- [ ] Implement cross-process local-filesystem exclusion over read-modify-write, with bounded waiting and clear lock-conflict errors. Do not use a lease timeout to steal a live writer's lock. Prefer a recoverable owner identity protocol; if ownership cannot be proved dead, fail conservatively rather than remove its lock. Document local-filesystem/single-host limits. Add focused recovery tests for a process interrupted while holding a lock, including acquisition before normal work starts.
- [ ] Use exclusive UUID temporary files, write+file sync, rename, and directory sync where supported; clean only owned temporary files. Reject unsupported async transaction callbacks. Do not claim power-loss durability beyond platform support. Keep migration behavior and create a backup before persisting a legacy schema migration.
- [ ] Verify focused tests, `npm run check`, and `npm test`. Self-review and commit only task files. Record exact RED/GREEN evidence and any platform limitations.

## Task 2: Atomic evaluation coordination and completion invariants

**Files:** Create `server/coordination-core.mjs`, `tests/v262-coordination.test.mjs`; modify `server/state-store.mjs`; extract shared evidence helpers into `server/evidence-records.mjs` only if needed to avoid duplication/cycles. A minimal `server/mcp-server.mjs` initialization projection preserves the legacy initialization response by omitting additive coordination metadata from that response only; persisted state and store return values retain enumerable metadata.

**Interfaces:**
- Export `getStateIdentity(project) -> { projectId, epoch, revision }` and `getCompletionState(project) -> { recommended, missingCriteria, blockers, contradictions, uncertainties, assessmentSource }`.
- Persist additive `project.coordination = { epoch, operations, criteria }` when needed. New initialization uses a fresh UUID epoch; existing state without metadata uses a deterministic legacy identity derived from projectId and creation identity. Reset must replace the epoch.
- Add `store.coordinateEvaluation(projectId, input)`. It consumes existing evaluation fields plus `input.coordination`: `{ operationId, expectedRevision, stateEpoch, evidenceRecords?, criteriaUpdates?, claimUpdates?, changedDependencyIds?, efficiencyEvents? }`.
- `criteriaUpdates` entries: `{ goalId, criterion, satisfied, evidenceIds }` using an exact existing success-criterion string; duplicate strings for a goal share that declared criterion. `claimUpdates` entries: `{ claimId, status?, evidenceIds?, counterEvidenceIds? }`. Efficiency events retain the existing reported provenance contract.
- Return `{ evaluation, identity, completion, changed, refs, replayed }`; refs use the Task 3 shape `{ projectId, epoch, kind, id, revision }`; evidence ref IDs are canonical cache keys, while criterion evidenceIds use unambiguous evidenceId metadata. Store operation digest and original semantic response atomically with the state; operation records are not automatically pruned.
- Extend the transaction callback with a second argument `{ noCommit(result) }`: returning its private marker bypasses persistence for committed-operation replays. Ordinary callbacks retain Task 1 behavior. A noCommit callback must not mutate the project; reject that misuse. Replay returns the original identity/completion labelled `replayed`, never pretending that the historical response describes later state.

- [ ] RED tests: fusion commits evidence+evaluation+explicit criterion/claim updates+ledger+failed-strategy bookkeeping in one revision; invalid final update rolls everything back; two competing expected revisions produce one commit and one conflict; retry after reconstructing ProjectStore replays the original result without another write; different payload with reused operation ID fails.
- [ ] Test operation IDs such as `__proto__`/`constructor` without inherited-key lookup or prototype mutation, and noCommit without revision advancement or speculative mutation.
- [ ] Test completion refusal for no registered criteria, missing/invalid/stale evidence, blocked goals/dependencies, contradicted claims, and unevaluated criteria; false values must not become omitted/true. Explicitly satisfied supported criteria may recommend completion; reported assessments stay labelled reported, not independent verification.
- [ ] Run focused tests and record RED.
- [ ] Build the fused transition atop `transact`. Check committed operation ID/digest before expectedRevision so a response-lost retry succeeds. Canonicalize JSON without accepting accessors/non-JSON values. Validate all references and mappings. Support every requested existing criterion; reject unknown mappings. Reuse existing record validators and invalidation logic, and only update explicitly mapped goals/claims. Do not treat a bare verified outcome as fulfilling unrelated criteria.
- [ ] Ensure invalidation revokes completion recommendations, changed criteria and replaced evidence content under the same evidenceId invalidate old verdicts via digest pinning, state generation prevents cross-reset replay, and all old evaluation behavior remains unchanged.
- [ ] Run focused tests, `npm run check`, and `npm test`; commit and report.

## Task 3: Decision capsules and scoped reference expansion

**Files:** Create `server/decision-capsule.mjs`, `server/state-references.mjs`, `tests/v262-capsule.test.mjs`, `tests/v262-references.test.mjs`; modify `server/state-store.mjs` with explicit new readers and `server/coordination-core.mjs` for shared conservative risk assessment.

**Interfaces:**
- `makeStateRef(project, kind, record)` returns `{ projectId, epoch, kind, id, revision }`. Kinds cover the existing goal, claim, plan, evaluation, evidence, observation, failedStrategy, checkpoint, adaptation, transfer, lesson, hypothesis, experiment records that have resolvable identities. Evidence refs use canonical cache key as id; other refs use the existing record ID. Do not confuse evidenceId metadata with the cache identity.
- `resolveStateReferences(project, references)` returns `{ identity, references, resync? }`. Entries preserve the requested `reference` and status `current`, `unchanged`, `stale`, `not_found`, or `scope_mismatch`. Exact revisions are `unchanged` with `record/ref`; omitted revision requests are `current`. Stale results label latest data `currentRecord/currentRef`, never as the requested old version. Scope mismatch never exposes records from another project or epoch.
- `buildDecisionCapsule(project, { goalId?, cursor?, knownRefs?, maxItems? })` returns `{ identity, goal, constraints, unmetCriteria, claims, blockers, uncertainty, risk, failedStrategies, changedEvidence, completion, refs, incomplete, expansion }`.
- Cursor is `{ projectId, epoch, revision }`. Scope mismatch/future cursor produces explicit resync guidance, not an empty delta. `maxItems` 1..20 applies only to optional recent changes; mandatory constraints, contradictions, unmet criteria and relevant failed strategies are never silently truncated. References/continuations flag omitted optional details.
- Add `store.getDecisionCapsule(projectId, options)` and `store.getReferences(projectId, references)` as read-only callers of the pure modules. Existing getContext paths remain unchanged.
- Share significant plan-risk assessment with core completion. Risk remains `unknown` unless the latest explicit plan-scoped evaluation is verified, has no missing criteria, references nonempty fresh valid evidence, and its associated goal has nonempty currently supported explicit criterion assessments. Label that case `reported_verified`, never independent safety certification; keep the risk visible and invalidate it with its supporting evidence. Missing goal/criteria/evidence remains unknown and prevents completion.
- Core completion also retains current recorded uncertainty from the latest checkpoint, latest consolidation, and open hypotheses, with provenance. Superseded snapshots and resolved hypotheses do not retain their veto. With no materiality field, handling is conservatively project-wide; verified criterion updates do not silently clear other recorded unknowns.

- [ ] RED tests: hard constraints and counter-evidence survive an unchanged cursor; claims preserve known/inferred/unknown/contradicted and supporting/counter-evidence refs; malformed or foreign cursors resync; necessary risks with no evidence remain unknown; unavailable refs do not fabricate history.
- [ ] Test exact-ref expansion returns original records; record revisions remain unchanged after unrelated mutations; reset changes epoch; invalidation changes evidence references; known missing records receive explicit status; large mandatory constraint sets are not discarded; no criteria/no change cannot recommend completion.
- [ ] Run focused tests and record RED.
- [ ] Implement using state identity and completion from Task 2. Delta supplements rather than replaces mandatory current context. Never label a heuristic capsule semantically lossless. Expansion preserves stored records and provenance. Do not write on ordinary capsule/ref reads.
- [ ] Run focused tests, `npm run check`, and `npm test`; commit and report.

## Task 4: MCP integration, result projection, and host advice

**Files:** Create `server/host-capabilities.mjs`, `tests/v262-mcp.test.mjs`, `tests/v262-host.test.mjs`; modify `server/mcp-server.mjs`, `server/control-results.mjs`, `docs/TOOLS.md`, and the applicable Forge skill policy files. Extend the live result-level enum assertion in `tests/v261-compact-results.test.mjs` for the approved capsule option, retaining legacy assertions.

**Interfaces:**
- Preserve exactly 19 tool names. Extend `forge_context.resultLevel` with `capsule`, and optional `goalId`, `cursor`, `knownRefs`, `references`. References are an explicit full-record read branch; reject contradictory options such as refs+cursor or capsule+legacy sinceRevision. Legacy full/recovery remain directly accessible.
- `forge_evaluate.coordination` uses Task 2 envelope; omission invokes the old evaluation path. Capsule/summary must never remove errors, unmet criteria, or completion reasons.
- Every projection preserves a replay's historical identity and completion. Do not replace them with a newly read current capsule; if current context is also returned, label it separately with its own identity.
- Extend control `resultLevel` with explicit `capsule` on route/plan/observe/evaluate. Legacy full/summary projections remain unchanged. Projectless route returns complete decision guidance with no invented persisted refs.
- `forge_route.includeContext: true` includes a decision capsule in the route response. `hostCapabilities` is an optional validated envelope `{ deferredDiscovery?: boolean, allowedSubset?: boolean, discoveryAvailable?: boolean }`.
- `selectCapabilities({ stage, hostCapabilities })` returns advisory selection and fallback, never host enforcement. Unknown/unsupported host uses the stable catalog. Recovery/context and expansion remain reachable. Restriction advice never implies new permissions or proven cache savings.

- [ ] RED integration tests: tools/list still exposes 19 names; old input/output cases remain identical apart from additive full-state metadata; fused evaluate can be invoked and replayed through MCP; capsule refs expand via forge_context; malformed combinations return useful errors.
- [ ] Test includeContext works in one MCP call, unknown host fallback, failed discovery fallback, and unsupported/projectless inputs. Full context must remain obtainable without an efficiency override.
- [ ] Implement schemas, validation and dispatch using earlier interfaces. No extra public tool and no host feature claims based only on plugin configuration. Keep schemas stable during runtime.
- [ ] Document practical opt-in examples, revision conflicts/replays, completion provenance, and the limit that capsule/model quality remains unmeasured. Skill advice must not promote new projection/relevance modes as default.
- [ ] Run focused tests, `npm run check`, and `npm test`; commit and report.

## Task 5: Honest benchmark, release metadata, and packages

**Files:** Create `scripts/benchmark-v262.mjs`, `tests/v262-benchmark.test.mjs`, `docs/COORDINATION-v2.6.2.md`, `docs/EVALUATION-v2.6.2.md`; modify package.json, `.codex-plugin/plugin.json`, server version, README, check script, and release-version assertions. Preserve immutable fixtures including `tests/fixtures/v261-uploaded` created from the original archive before Task 1.

**Interfaces:**
- Export `benchmarkScenarios()` and `runBenchmarkScenario(scenario, variant)`; variants `v261_uploaded_full`, `v261_uploaded_compact`, `v262_legacy`, `v262_fusion`, `v262_capsule`, `v262_combined`. Use actual MCP dispatch and isolated stores.
- Isolate atomic fusion from projection: fusion-only retains the legacy context path and counts any required identity reads; capsule-returning `route.includeContext` belongs in the combined variant. Keep raw JSON-RPC request/response envelopes via the existing `processRpcMessage` interface, including IDs and result/error wrappers; document any excluded transport framing separately.
- `npm run benchmark:efficiency` runs the v2.6.2 comparison. Retain `benchmark:efficiency:v261` and the original v261 harness for historical regression tests.
- Report workload success, verified success, false-completion count, coordination calls, actual request/response/combined bytes, expansion/replay/conflict calls, work calls, storage bytes, and repeated latency samples. Model tokens/turns/cache/billing stay null. Context bytes are a response subset.
- Include a machine-readable model-evaluation dataset/rubric and status `not_run` when no real model runtime exists. Never substitute a deterministic driver or coding subagent for paired product model evaluations.

- [ ] RED tests: fixture hashes unchanged; measured bytes recompute from raw request/response traces; quality is identical against independently checked artifacts for ordinary success, old constraint/counter-evidence, changed dependency, unresolved risk, and recovery/retry cases; false completion is rejected; variants perform the same useful work.
- [ ] Implement benchmark with fixed workload/criteria and transparent per-scenario results. Count support reads, discovery advice, expansion, errors, locking/serialization time and file size effects; do not cherry-pick successful workloads or demand every metric improve. Scope benefits to observed workload classes.
- [ ] Advance package/plugin/server version to 2.6.2. Keep legal bytes unchanged. Update only current release assertions; fixture versions/hashes remain original. Extend syntax check to new production modules without dropping previous coverage. Preserve packaging exclusion of logs, runtime state, git and scratch.
- [ ] Add README/changelog and evaluation protocol with fixed rubrics (constraint preservation, correct tool/evidence use, recovery, premature completion), paired model configuration requirements, and honest `not_run` status. New capsule/host advice stay opt-in.
- [ ] Run `npm run check`, complete `npm test`, and `npm run benchmark:efficiency`; commit and report actual metrics.
- [ ] Controller: perform independent whole-branch review, fix findings, package both ZIP variants via existing packager, fresh-extract each, rerun check/tests/benchmark, initialize stdio MCP from unrelated working directory, discover 19 tools, and compare legal hashes. Preserve final source and evidence as deliverables; do not push or publish.
