---
name: astra-project-forge
description: Use when the Astra model gate is eligible and work in any domain has meaningful complexity, uncertainty, dependent steps, repeated iteration, verification needs, recovery needs, or benefits from project-state continuity across attempts or sessions.
---

# Astra Project Forge

## Model gate and semantic activation

This skill is eligible only when Codex model-gate metadata says **ELIGIBLE**. If it says **NOT ELIGIBLE**, do not activate Forge or call its MCP tools; if Forge would help, ask whether the user wants to switch to the configured Astra model. Never claim to switch models yourself.

No keyword or exact prompt is required. Decide from task meaning in **any domain**. Do not activate for trivial one-shot work that gains nothing from continuity, uncertainty tracking, iterative verification, or adaptation.

## Adaptive routing

Use `forge_route` (or legacy `adaptive_route_task`) when the appropriate intensity is unclear. Choose the smallest useful profile: `off`, `light`, `standard`, or `deep`. The **workflow budget** limits adaptive cycles; **do not treat it as actual token usage** or hidden reasoning-token control.

## Selective state retrieval

Prefer `forge_context` and **selective state retrieval**. Start with `summary`; use `working` for current decisions; use `full` only when older history materially matters; use `recovery` after interruption, failure, or a context switch.

## Goal graph

Represent long-horizon work as a goal graph. Respect dependencies and blockers. A goal is `verified` only when evidence supports its success criteria. Prefer the highest-value actionable goal rather than simply the newest task.

## Epistemic state

Keep **Known**, **Inferred**, **Unknown**, and **Contradicted** separate. Confidence is not proof. Known claims require evidence. Contradictory evidence should remain visible until evaluated instead of being silently overwritten.

## Planning, evaluation, and adaptation

Use concise plan records: next action, why it is useful, expected evidence, risk, reversibility, and qualitative usage impact. Do not store hidden chain-of-thought.

Evaluate results against explicit criteria as `verified`, `partially_verified`, `inconclusive`, `falsified`, or `blocked`. After failure, classify the cause before retrying and materially change the strategy unless new evidence justifies a similar attempt.

## Transfer and recovery

Treat cross-project lessons as **transfer candidates**, not facts. Validate them with evidence in the current project before promotion. Recover from checkpoints and open work after interruptions, permission denials, tool failures, requirement changes, or context switches. Never bypass permission controls.

## Available capabilities

Forge coordinates **available capabilities** rather than replacing specialized tools. Use repository, documentation, testing, review, security, runtime, CI, research, data, design, writing, or other capabilities only when the current environment actually exposes them. Persist only decision-relevant evidence.

## Usage & Cost

Forge may increase model/tool usage through extra planning, retrieval, tool calls, verification, and adaptive cycles. Prefer `off` or `light` when sufficient. `MINIMAL`, `LOW`, `MODERATE`, `HIGH`, and `VERY HIGH` are qualitative usage-impact labels, not billing estimates.

When `forge_route` returns `noticeRequired: true`, show the user the universal **Usage & Cost Notice** before continuing and then record acknowledgement with `forge_adapt` using `operation: "acknowledge_usage"`. When it returns `deepNoticeRequired: true`, explicitly warn that **Deep** mode can materially increase usage before the first Deep cycle and record the acknowledgement. Do not repeat a notice after its acknowledgement flag is stored.

## Stop conditions

Stop when success criteria are verified, required external information is missing, permission blocks progress, or another cycle is unlikely to improve the result. Report blockers and uncertainty explicitly.

Astra Project Forge is an agentic coordination layer; it **does not create AGI**, retrain model weights, or permanently self-modify the model.
