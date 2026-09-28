# Astra Project Forge — Local Edition 2.6.1

Astra Project Forge is a **local-first General Adaptive Agent Layer** for qualifying complex work in Codex. It does not turn Astra into AGI and it does not retrain model weights. It adds structured project state, goal management, uncertainty tracking, planning, evaluation, adaptation, transfer candidates, recovery context, and usage-aware routing around an eligible Astra model.

## Efficiency First

- BALANCED is default.
- Soft budgets guide; they do not block useful work.
- Justify-before-spend applies after the soft budget.
- Fresh evidence is reused when safe.
- Delta/compacted context is preferred.
- Duplicate calls and unchanged failed strategies are avoided.
- Verification scales with risk.
- Verified success stops work immediately.
- Forge never invents usage/cost savings.

Efficiency policies are `eco`, `balanced`, `performance`, and `maximum`.
They are separate from the existing routing profiles `off`, `light`, `standard`,
and `deep`. Useful work may exceed a soft budget with a concrete recorded
justification before additional expensive work. Efficiency must preserve the
quality floor; available budget never justifies continuing after verified success.

All v2.6.1 tool inputs are optional additions to the nine `forge_*` and ten
legacy `adaptive_*` tools. See [MCP tools](docs/TOOLS.md) for conditional
requirements when opting into new operations and [the approved design](docs/DESIGN-v2.6.1.md).

### Compact control responses (opt-in)

The unpublished 2.6.1 follow-up adds `resultLevel: "summary"` to `forge_route`,
`forge_plan`, `forge_observe`, and `forge_evaluate`. Omitted `resultLevel` or
`"full"` retains complete responses. Projection changes only returned fields;
persisted evidence, routing decisions, safety checks, and soft budgets are unchanged.
See [compact responses](docs/COMPACT-RESPONSES.md) for exact omissions, examples,
read-only full-context recovery, and the projectless-route exception.

The verified 2.6.1 baseline is commit `cd0edae9921c80784e11ce3bcaec57f29c224786`;
the candidate is identified by its own commit and content hashes, not a new
published version. Both retain package version `2.6.1`.

## Retained v2.6 capabilities

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
npm run benchmark:efficiency
```

No `npm install` is required; the local runtime uses Node.js built-ins only.

The benchmark executes equivalent deterministic file/artifact workloads in three
modes: `v260_baseline` (frozen v2.6.0), `v261_verified` (frozen verified commit
`cd0edae`), and `v261_compact` (current candidate with summary control responses).
It reports verified outcomes, actual work and coordination calls, request and
response bytes, their combined cost, context bytes, reuse, retries, and local timing.
Context bytes are already included in response bytes, not added again.
The quality floor requires no verified-quality regression, including refusing
success with unresolved risk. This scripted harness is not a real model study:
model turns, tokens, host cache hits, and billing are unavailable (`null`).
Timing varies; no speed or token-savings guarantee follows from these samples.
Baseline provenance and immutable source/legal files ship in
`tests/fixtures/v260-baseline/` and `tests/fixtures/v261-verified/`.
See the [three-way method and limitations](docs/COMPACT-RESPONSES.md#three-way-benchmark).

## Portable release packages

With Node.js 20+, npm, `zip`, and `unzip` available, build both local archives:

```bash
npm run package:release -- --output-dir /absolute/path/to/release-artifacts
```

The output directory must be outside the plugin. The helper works from an
extracted plugin and uses only package-local inputs, including
`scripts/marketplace.json`. It includes hidden plugin metadata, hooks, assets,
source, tests, docs, and benchmark fixtures; excludes Git, scratch directories,
local state, dependencies, logs, and old ZIPs; and preserves legal file bytes.
Sorted entries and normalized ZIP timestamps/permissions make repeated builds
byte-identical with the same inputs and zip implementation. An existing output
ZIP is replaced, so obsolete entries cannot accumulate.

Use a new unique outside-repo output directory for follow-up candidate archives;
retain the original verified archives and evidence without overwriting them.

`astra-project-forge-local-2.6.1.zip` contains `astra-project-forge-2.6.1/`.
`astra-project-forge-local-marketplace-2.6.1.zip` contains
`astra-project-forge-local-marketplace-2.6.1/`, with
`.agents/plugins/marketplace.json` pointing to `./plugins/astra-project-forge`.
See [installation and extraction checks](docs/INSTALL.md). Building an archive
does not certify it: final release review must precede the final build and
fresh verification of both extractions.

## License and attribution

Astra Project Forge v2.6.1 is distributed under **GNU Affero General Public License v3.0 only (AGPL-3.0-only)**. See:

- `LICENSE`
- `NOTICE.md`
- `ATTRIBUTION.md`

Attribution is proportional to the amount and role of Forge source material reused. Direct forks should credit Forge prominently; small reused components can use local/component-level attribution. Independent reimplementations and ideas-only inspiration are treated separately. No trademark policy is claimed in v2.6.
