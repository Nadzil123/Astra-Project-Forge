# Astra Project Forge — Local Edition 2.6.0

Astra Project Forge is a **local-first General Adaptive Agent Layer** for qualifying complex work in Codex. It does not turn Astra into AGI and it does not retrain model weights. It adds structured project state, goal management, uncertainty tracking, planning, evaluation, adaptation, transfer candidates, recovery context, and usage-aware routing around an eligible Astra model.

## What v2.6 adds

- **Goal Graph** — goals, subgoals, dependencies, priorities, blockers, and evidence-backed verification.
- **Epistemic State** — keeps **Known**, **Inferred**, **Unknown**, and **Contradicted** claims separate.
- **Planner records** — stores concise next actions, expected evidence, risk, reversibility, and qualitative usage impact without storing hidden chain-of-thought.
- **Evaluator** — separates verified, partially verified, inconclusive, falsified, and blocked outcomes.
- **Adaptation Engine** — classifies why an attempt failed before changing strategy.
- **Transfer candidates** — cross-project lessons remain hypotheses until validated by local evidence.
- **Recovery context** — resumes from checkpoints, open goals, unresolved claims, plans, and recent adaptation state.
- **Adaptive routing** — chooses `off`, `light`, `standard`, or `deep` and prefers the smallest useful workflow.
- **Selective state retrieval** — reads `summary`, `working`, `full`, or `recovery` context rather than dumping all history by default.
- **Available capabilities** — Forge coordinates specialized capabilities that are actually available; it does not assume a plugin is installed.
- **Backward compatibility** — existing v2.5 `adaptive_*` MCP tools remain available while v2.6 adds the `forge_*` facade.

## ⚠️ Usage & Cost Notice

Astra Project Forge may increase overall model usage compared with using Astra without this plugin. This is because the plugin may perform additional planning, reasoning, project-state retrieval, tool calls, verification, evaluation, and multiple adaptive cycles when working on complex or long-running tasks.

As a result, token usage, compute usage, or associated costs may increase, especially when using **Standard** or **Deep** modes. Astra Project Forge does **not** change the model's base pricing; any increase comes from additional model and tool usage.

For simpler tasks, Astra Project Forge will attempt to minimize overhead by using **OFF** or **LIGHT** mode when appropriate. For longer projects, selective context retrieval and persistent project state may also reduce repeated work and improve overall efficiency.

**Use Astra Project Forge when the potential improvement in reliability, continuity, and problem-solving quality is worth the additional computational cost.**

### Usage Impact

Forge reports a qualitative workflow impact, not a billing quote:

```text
MINIMAL → LOW → MODERATE → HIGH → VERY HIGH
```

A workflow budget is **not** an actual token count and must not be treated as hidden reasoning-token control.

## Universal semantic activation

No keyword or exact conversation starter is required. The **model gate** must be eligible, then Forge may activate when work in **any domain** has meaningful complexity, uncertainty, dependent steps, repeated iteration, verification needs, or project continuity. Do not activate Forge for trivial one-shot tasks that gain nothing from persistent state or adaptive iteration.

## Model gate

The default expected slug remains `gpt-6-astra`. Override it when your Codex environment reports a different eligible Astra slug:

```bash
export ASTRA_REQUIRED_MODEL="the-exact-slug-codex-reports"
```

Forge never claims to switch models itself and never bypasses normal host/user permissions.

You can explicitly allow more than one eligible Astra slug:

```bash
export ASTRA_ALLOWED_MODELS="gpt-6-astra,gpt-6-astra-alt"
```

`ASTRA_REQUIRED_MODEL` remains the preferred/default slug shown when a switch is needed; `ASTRA_ALLOWED_MODELS` expands the accepted set.

## v2.6 MCP facade

Primary tools:

```text
forge_route
forge_goal
forge_context
forge_observe
forge_plan
forge_evaluate
forge_adapt
forge_checkpoint
forge_consolidate
```

The existing `adaptive_*` tools remain available for compatibility.

## Local MCP and data

The bundled server runs over stdio:

```bash
node server/mcp-server.mjs --stdio
```

Project state resolution order:

1. `ASTRA_PROJECT_FORGE_DATA_DIR`
2. `PLUGIN_DATA`
3. `~/.astra-project-forge`

State remains inspectable JSON and Forge adds no hidden network sync or telemetry.

## Test locally

```bash
npm test
npm run check
```

No `npm install` is required; the local runtime uses Node.js built-ins only.

## License and attribution

Astra Project Forge v2.6 is distributed under **GNU Affero General Public License v3.0 (AGPL-3.0)**. See:

- `LICENSE`
- `NOTICE.md`
- `ATTRIBUTION.md`

Attribution is proportional to the amount and role of Forge source material reused. Direct forks should credit Forge prominently; small reused components can use local/component-level attribution. Independent reimplementations and ideas-only inspiration are treated separately. No trademark policy is claimed in v2.6.
