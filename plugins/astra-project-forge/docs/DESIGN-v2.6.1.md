# Astra Project Forge v2.6.1 — Efficiency First
**Design Specification**
**Status:** Design approved for review
**Base:** Astra Project Forge v2.6.0
**Primary objective:** Reduce wasted computation while preserving verified-result quality.

## 1. Core Principle

> **Efficiency is not doing less work. Efficiency is eliminating work that does not meaningfully improve the probability of a verified success.**

Secondary rule:

> **If additional computation is likely to meaningfully improve correctness, resolve important uncertainty, reduce significant risk, or satisfy an unmet success criterion, it is not waste.**

v2.6.1 MUST NOT optimize for minimum usage at the expense of an unmet success criterion.

---

## 2. Product Goal

Astra Project Forge v2.6.1 adds an **Adaptive Efficiency Governor** around the v2.6 planning/execution loop.

The governor decides whether additional work is worth its cost by considering:

- expected goal progress,
- information gain,
- verification value,
- risk reduction,
- duplication,
- context cost,
- tool-call cost,
- and whether the success criteria are already satisfied.

The system SHOULD use the smallest amount of useful computation that still produces a verified result.

---

## 3. Efficiency Modes

Available policies:

- `eco`
- `balanced`
- `performance`
- `maximum`

Default:

```text
balanced
```

These policies influence soft budgets and escalation thresholds, but do not act as hard correctness limits.

### ECO
Favor low usage and short context. Escalate only when success criteria or important risks remain unresolved.

### BALANCED
Default. Minimize waste while preserving strong verification and adaptive escalation.

### PERFORMANCE
Prefer stronger verification and broader exploration when expected value remains meaningful.

### MAXIMUM
Permit aggressive exploration and verification when justified. Still stop redundant or zero-value work.

---

## 4. Adaptive Efficiency Governor

The governor operates before and after expensive actions.

```text
Candidate Action
      ↓
Utility Gate
      ↓
Marginal Value Gate
      ↓
Budget / Policy Check
      ↓
Execute or Reuse / Compress / Skip / Stop
      ↓
Measure Resulting Value
      ↓
Update Efficiency Ledger
```

### 4.1 Utility Gate

An action is considered useful when it is reasonably expected to:

- resolve important uncertainty,
- verify an unmet success criterion,
- materially change a decision,
- produce new evidence,
- detect a meaningful failure,
- reduce significant risk,
- unblock a dependency,
- or make measurable goal progress.

An action is likely wasteful when it mostly:

- repeats valid evidence,
- reloads irrelevant context,
- repeats the same failed strategy without new evidence,
- verifies something already sufficiently verified,
- calls a tool with no expected decision impact,
- continues after success is already verified,
- or duplicates another concurrent action without independent value.

### 4.2 Marginal Value Gate

The governor evaluates not only whether an action is useful, but whether the **next** action still adds enough value relative to what is already known.

Repeated verification SHOULD stop once additional checks have negligible expected impact on the final decision.

### 4.3 Justify-Before-Spend

Once a profile's soft budget has been reached, additional expensive work MUST have a recorded justification.

Example justification categories:

- `unmet_success_criterion`
- `important_uncertainty`
- `high_risk_verification`
- `contradictory_evidence`
- `blocked_goal`
- `new_evidence_requires_replan`

---

## 5. Soft Budgets

Existing `cycleBudget` becomes a **soft budget**, not a hard stop.

Example defaults:

```text
eco         → 1–2 cycles
balanced    → 2–3 cycles
performance → 3–5 cycles
maximum     → 5–6 cycles
```

These are workflow guidance values only.

If additional work has strong expected utility, Forge MAY exceed the soft budget.

If success is already verified, Forge SHOULD stop before reaching the budget.

---

## 6. Quality Floor / Non-Regression Guard

Efficiency is successful only when quality remains acceptable.

Examples:

```text
50% lower usage + materially worse verified result → failure
35% lower usage + same verified result             → success
10% lower usage + better verified result           → success
```

The percentages above are evaluation examples, not hard runtime rules.

If efficiency constraints prevent meeting success criteria, the governor MUST allow escalation.

---

## 7. Evidence Freshness

Evidence receives a freshness state:

- `fresh`
- `probably_fresh`
- `stale`
- `invalidated`

Rules:

- `fresh` → reuse
- `probably_fresh` → reuse unless risk justifies refresh
- `stale` → refresh when decision-relevant
- `invalidated` → do not rely on it without revalidation

---

## 8. State Fingerprinting and Smart Invalidation

Reusable evidence SHOULD track the inputs it depends on.

Example:

```json
{
  "evidenceId": "ev-test-123",
  "dependsOn": [
    "src/router.mjs@hashA",
    "config.json@hashB",
    "package-lock.json@hashC"
  ]
}
```

If relevant dependencies do not change, prior evidence MAY be reused.

If a dependency changes, only dependent evidence becomes stale or invalidated.

This avoids unnecessary global re-verification.

---

## 9. Context Delta Retrieval

Forge SHOULD prefer:

```text
stable summary
+ current active goal
+ changed evidence
+ unresolved contradictions
+ decision-relevant state
```

over full-history retrieval.

Unrelated history SHOULD remain omitted unless explicitly needed.

---

## 10. Context Compaction

Long-running project state SHOULD be compacted into:

- stable facts,
- verified lessons,
- active goals,
- unresolved uncertainties,
- recent meaningful changes,
- references to archived details.

Compaction MUST preserve references needed to recover full detail later.

---

## 11. Progressive Tool Results

Tools that can return large outputs SHOULD support progressive disclosure:

```text
summary → relevant sections → full/raw result
```

The default response SHOULD be the smallest useful representation.

Full output is retrieved only when the current decision requires it.

---

## 12. Tool Result Compression

Large tool results SHOULD be converted into decision-relevant records:

- relevant facts,
- evidence IDs,
- contradictions,
- unresolved questions,
- source references,
- affected goals.

Raw results MAY be retained outside active reasoning context when useful.

---

## 13. Tool-Call Deduplication

Before calling a tool, Forge checks:

- whether an equivalent valid result already exists,
- whether relevant inputs changed,
- whether the result would materially affect a decision.

Duplicate calls SHOULD be reused or skipped.

---

## 14. Action Coalescing

Independent operations that are safe and useful to perform together SHOULD be batched when doing so reduces model/tool round trips.

Do not batch actions when:

- one action's result determines whether another should happen,
- permissions differ,
- ordering affects correctness,
- or batching would increase risk.

---

## 15. Cheap-Probe-First

Before an expensive action, Forge SHOULD prefer a cheaper diagnostic when that diagnostic can meaningfully narrow the problem.

Example:

```text
small diagnostic
   ↓
enough evidence?
  ├─ yes → act
  └─ no  → deeper investigation
```

---

## 16. Adaptive Reasoning Escalation

Reasoning depth SHOULD escalate only when justified.

Conceptual ladder:

```text
low
 ↓ unresolved?
medium
 ↓ significant uncertainty / risk?
high
 ↓ exceptional difficulty?
maximum
```

The host's actual reasoning controls are used only when exposed and permitted.

Forge MUST NOT pretend to change reasoning effort when the host does not expose such a capability.

---

## 17. Escalation Hysteresis

Forge MUST avoid rapid oscillation between low and high effort.

Once escalated, effort SHOULD remain at the current level until:

- the triggering uncertainty is resolved,
- risk decreases materially,
- or success criteria become verified.

After de-escalation, minor uncertainty alone SHOULD NOT immediately trigger re-escalation.

---

## 18. Risk-Weighted Verification

Verification strength scales with consequence and uncertainty.

Examples:

```text
cosmetic/documentation change → light verification
ordinary implementation       → standard verification
state/schema migration         → strong regression verification
destructive/high-impact action → strongest available verification
```

Low-risk work SHOULD NOT receive high-cost verification without a specific reason.

---

## 19. Anti-Thrashing Memory

Forge records failed or disproven strategies.

Example:

```json
{
  "strategy": "retry-same-parser-config",
  "status": "failed",
  "cause": "configuration mismatch",
  "retryAllowedWhen": "configuration changes or new evidence appears"
}
```

A failed strategy SHOULD NOT be repeated unchanged without new evidence or changed conditions.

---

## 20. Parallelism Gate

Parallel execution is allowed only when tasks are sufficiently independent and parallelism is expected to:

- reduce latency,
- provide valuable independent verification,
- or explore meaningfully different strategies.

Parallelism SHOULD NOT be used merely because multiple agents/tools are available.

Redundant parallel work is waste.

---

## 21. Completion Gate

Forge stops immediately when all are true:

```text
success criteria satisfied        = yes
evidence sufficient               = yes
important contradiction remaining = no
meaningful unresolved risk        = no
```

Available budget is never a reason to continue after verified success.

---

## 22. Cache-Aware Context Layout

Where the host/API benefits from stable prompt prefixes:

- stable instructions and reusable project context SHOULD stay stable,
- dynamic state SHOULD be appended later,
- avoid unnecessary mutation of reusable prompt prefixes.

Forge MUST NOT fabricate cache-hit data when telemetry is unavailable.

---

## 23. Efficiency Ledger

Per project/run, Forge records decision-level efficiency metadata.

Example:

```json
{
  "usefulCycles": 3,
  "avoidedCycles": 2,
  "reusedEvidence": 7,
  "duplicateToolCallsAvoided": 4,
  "contextsCompacted": 2,
  "reasoningEscalations": 1,
  "softBudgetOverrides": 1,
  "stopReason": "SUCCESS_VERIFIED"
}
```

Only metrics Forge can actually observe may be recorded.

No fake token, compute, dollar, or billing estimates.

---

## 24. Benchmark Harness

v2.6.1 MUST be compared against v2.6.0 on equivalent workloads.

Measure when available:

- task success,
- verified success,
- model turns,
- adaptive cycles,
- tool calls,
- repeated tool calls,
- context supplied,
- evidence reused,
- retries,
- wall-clock time,
- token/usage telemetry if the host exposes it.

Primary success condition:

> **Lower resource use without meaningful verified-quality regression.**

Secondary benchmark target:

- investigate whether representative complex workloads can reduce usage by roughly 30–50%,
- but do NOT force that target when it harms verified success.

This target is an evaluation objective, not a runtime promise.

---

## 25. Compatibility

v2.6.1 MUST preserve:

- v2.6 state compatibility,
- v2.5 → v2.6 migration compatibility,
- existing `forge_*` tool contracts unless explicitly versioned,
- legacy `adaptive_*` compatibility aliases,
- local-first storage,
- permission and safety boundaries.

Schema changes SHOULD be additive where possible.

---

## 26. Non-Goals

v2.6.1 does NOT add:

- new general intelligence claims,
- model-weight learning,
- autonomous self-modification,
- cloud sync,
- fake billing telemetry,
- hard token pricing estimates,
- forced multi-agent execution,
- hard cycle caps that can prevent success,
- aggressive context deletion without recoverable references.

---

## 27. Acceptance Criteria

v2.6.1 is acceptable when:

1. Useful compute is never rejected merely because it exceeds a soft budget.
2. Redundant work can be skipped, reused, compressed, or stopped.
3. Verified-success quality does not materially regress in the benchmark suite.
4. Evidence freshness and invalidation behave deterministically.
5. Repeated tool calls are deduplicated when inputs/evidence remain valid.
6. Context delta retrieval omits irrelevant history.
7. Progressive tool results avoid unnecessary full-output retrieval.
8. Failed strategies are not repeated unchanged without new evidence.
9. Verification strength scales with risk.
10. Escalation hysteresis prevents effort thrashing.
11. Completion stops work once success is sufficiently verified.
12. Efficiency ledger records only observable metrics.
13. v2.6 and legacy compatibility tests continue to pass.
14. Benchmark reports compare v2.6.0 and v2.6.1 using equivalent workloads.

---

## 28. Scope Freeze

After approval of this specification, v2.6.1 feature scope is frozen.

New efficiency mechanisms discovered during implementation should be:

- recorded as benchmark findings,
- fixed only if necessary for correctness or the approved acceptance criteria,
- otherwise deferred to a future release.

This prevents the efficiency layer itself from becoming unnecessary overhead.
