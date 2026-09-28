---
name: astra-project-forge
description: Use when the Astra model gate is eligible and work in any domain has meaningful complexity, uncertainty, dependent steps, repeated iteration, verification needs, recovery needs, or benefits from project-state continuity across attempts or sessions.
---

# Astra Project Forge

## Model gate and semantic activation

This skill is eligible only when Codex model-gate metadata says **ELIGIBLE**. If it says **NOT ELIGIBLE**, do not activate Forge or call its MCP tools; if Forge would help, ask whether the user wants to switch to the configured Astra model. Never claim to switch models yourself.

No keyword or exact prompt is required. Decide from task meaning in **any domain**. Do not activate for trivial one-shot work that gains nothing from continuity, uncertainty tracking, iterative verification, or adaptation.

## Adaptive routing

Use `forge_route` (or legacy `adaptive_route_task`) when the appropriate intensity is unclear. Choose the smallest useful profile: `off`, `light`, `standard`, or `deep`. The **workflow budget** is soft guidance, not a hard stop; **do not treat it as actual token usage** or hidden reasoning-token control.

## Efficiency First

Default to the `balanced` efficiency policy. **Useful computation is not waste.** Before additional expensive work, identify its expected value: change a decision, verify an unmet criterion, resolve important uncertainty, produce new evidence, reduce meaningful risk, or unblock progress.

Soft budgets provide guidance, not a hard stop. At exhaustion, use **justify-before-spend**: record a concrete reason before another expensive cycle, then proceed with useful work. Preserve quality; escalate when needed to meet success criteria. On `forge_plan`, supply `budgetOverride:{category,justification}`; for example, `category:"unmet_success_criterion"`, `justification:"Fresh package verification remains required after source tests passed"`. No extra governor call is required. `MODERATE`, `HIGH`, and `VERY HIGH` plans are guarded as expensive; the default `LOW` is a caller-reported cheap probe. Classify cost and cycle position honestly; never understate them to evade the guard.

Use marginal value: stop repeated verification when another check is unlikely to change the decision. Scale verification to consequence and uncertainty. Avoid duplicate tool calls and irrelevant context reloads. Apply cheap-probe-first: run a cheaper diagnostic that can narrow the problem; act when evidence is sufficient, otherwise investigate deeper.

Reuse fresh evidence with unchanged dependencies. For `probably_fresh`, high risk requires refresh; otherwise reuse. Refresh `stale` evidence when decision-relevant; rely on `invalidated` evidence only after revalidation. Register `evidenceRecord` through `forge_observe` with complete versioned `dependencies` and exact stable `dependencyIds`; use `cacheRequest` on routing/planning for reuse. After inputs change, use `forge_adapt` operation `invalidate_evidence` with `changedDependencyIds` to stale only dependent evidence.

Apply escalation hysteresis: hold elevated effort until triggering uncertainty is resolved, risk decreases materially, or success is verified. After de-escalation, minor uncertainty must not trigger immediate re-escalation. Use host reasoning controls only when exposed and permitted; never pretend Forge recommendations change host effort.

Coalesce independent safe actions to reduce round trips. Keep actions sequential when one result determines another action, permissions differ, ordering matters, or batching increases risk. Parallel tasks must be independent, with expected value from lower latency, independent verification, or meaningfully different strategies; do not duplicate work merely because workers are available.

## Selective state retrieval

Prefer `forge_context` and **selective state retrieval**. Start with `summary`; use `working` for current decisions; use `full` only when older history materially matters; use `recovery` after interruption, failure, or a context switch.

On `forge_context`, use `resultLevel` progressively: `summary`, `relevant`, then `full` only as the decision requires. Use `sinceRevision` for delta retrieval; omit `sinceRevision` for full/raw or recovery output, including recovery from an invalid cursor. Compact into stable facts, active goals, unresolved uncertainties, verified lessons, recent changes, and archive references. Keep stable instructions and reusable context in stable prefixes; append dynamic state later.

For `forge_route`, `forge_plan`, `forge_observe`, and `forge_evaluate`, optional `resultLevel` accepts only `summary` or `full`; omitted/full preserves the complete response. See the [compact control API reference](../../docs/COMPACT-RESPONSES.md) for exact omissions, read-only full-context recovery without repeating mutations, and the projectless-route exception.

## Goal graph

Represent long-horizon work as a goal graph. Respect dependencies and blockers. A goal is `verified` only when evidence supports its success criteria. Prefer the highest-value actionable goal rather than simply the newest task.

## Epistemic state

Keep **Known**, **Inferred**, **Unknown**, and **Contradicted** separate. Confidence is not proof. Known claims require evidence. Contradictory evidence should remain visible until evaluated instead of being silently overwritten.

## Planning, evaluation, and adaptation

Use concise plan records: next action, why it is useful, expected evidence, risk, reversibility, and qualitative usage impact. Do not store hidden chain-of-thought.

Evaluate results against explicit criteria as `verified`, `partially_verified`, `inconclusive`, `falsified`, or `blocked`. Use anti-thrashing memory: record failed strategies, cause, and retry conditions; do not repeat a strategy unchanged without new evidence or changed conditions.

## Transfer and recovery

Treat cross-project lessons as **transfer candidates**, not facts. Validate them with evidence in the current project before promotion. Recover from checkpoints and open work after interruptions, permission denials, tool failures, requirement changes, or context switches. Never bypass permission controls.

## Available capabilities

Forge coordinates **available capabilities** rather than replacing specialized tools. Use repository, documentation, testing, review, security, runtime, CI, research, data, design, writing, or other capabilities only when the current environment actually exposes them. Persist only decision-relevant evidence.

## Usage & Cost

Forge may increase model/tool usage through extra planning, retrieval, tool calls, verification, and adaptive cycles. Prefer `off` or `light` when sufficient. `MINIMAL`, `LOW`, `MODERATE`, `HIGH`, and `VERY HIGH` are qualitative usage-impact labels, not billing estimates.

When `forge_route` returns `noticeRequired: true`, show the user the universal **Usage & Cost Notice** before continuing and then record acknowledgement with `forge_adapt` using `operation: "acknowledge_usage"`. When it returns `deepNoticeRequired: true`, explicitly warn that **Deep** mode can materially increase usage before the first Deep cycle and record the acknowledgement. Do not repeat a notice after its acknowledgement flag is stored.

Do not fabricate token counts, compute usage, cache hits, billing, or savings when the host does not expose those measurements. For policy changes use `forge_adapt` operation `set_efficiency_policy` with `efficiencyPolicy`. Record actual reported actions through `record_efficiency_event` with `eventType` and `provenance:{source:"reported",reference:"<evidence>"}`; distinguish reported actions from store-observed events. Plans/recommendations are not executed cycles; context reads do not produce counter events.

## Stop conditions

When success criteria are satisfied, evidence is sufficient, no important contradiction remains, and no meaningful unresolved risk remains, stop immediately even if workflow budget remains.

Stop when required external information is missing, permission blocks progress, or another cycle is unlikely to improve the result. Report blockers and uncertainty explicitly.

Astra Project Forge is an agentic coordination layer; it **does not create AGI**, retrain model weights, or permanently self-modify the model.
