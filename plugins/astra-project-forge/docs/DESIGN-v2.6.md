# Astra Project Forge v2.6 — General Adaptive Agent Layer
**Design specification — Revised**
**Status:** Approved design, revised licensing/attribution direction
**Language:** English (universal)
**Target runtime:** Codex local plugin + stdio MCP
**Compatibility baseline:** Astra Project Forge v2.5.0

## 1. Purpose

Astra Project Forge v2.6 evolves the plugin from an adaptive project-memory workflow into a **General Adaptive Agent Layer**.

The objective is not to claim that Astra becomes AGI. The objective is to add a structured, general-purpose layer around the model that improves:

- goal decomposition,
- project-state continuity,
- uncertainty tracking,
- evidence management,
- planning,
- tool/capability coordination,
- evaluation,
- adaptation after failure,
- transfer of verified lessons,
- recovery,
- safety/permission awareness,
- and usage/cost awareness.

The plugin remains local-first and must not claim model-weight retraining, permanent self-modification, consciousness, or AGI status.

---

## 2. Conceptual Basis

The v2.6 architecture follows this conceptual capability progression:

1. Language capability
2. Multimodal capability
3. Reasoning
4. Generalization and transfer
5. Agentic execution
6. Continuous adaptation
7. Broader general intelligence as a conceptual target

Forge v2.6 focuses on **generalization, agentic execution, persistent state, adaptation, evaluation, recovery, and control**.

The project must preserve the distinction between:
- a model,
- an agentic system built around the model,
- and AGI.

---

## 3. Design Principles

### 3.1 Use the smallest useful workflow

Routing levels:

- `off`
- `light`
- `standard`
- `deep`

The router should prefer the least expensive profile that is still likely to achieve the user's objective.

### 3.2 Evidence over unsupported certainty

Forge distinguishes:

- **Known** — directly supported by evidence
- **Inferred** — plausible but not directly verified
- **Unknown** — decision-relevant uncertainty
- **Contradicted** — conflicting evidence requiring resolution

### 3.3 Selective memory over full-history dumping

Forge retrieves only the minimum state needed for the next decision.

### 3.4 Specialized capabilities remain specialized

Forge coordinates available tools, plugins, and skills rather than pretending to replace them.

### 3.5 No silent permission bypass

Host and user permission rules remain authoritative.

### 3.6 No false AGI or self-learning claims

Project-state learning is external state, not model-weight training.

---

## 4. High-Level Architecture

```text
User Goal
   ↓
Model / Eligibility Gate
   ↓
Adaptive Router
   ↓
Goal Graph
   ↓
Epistemic State
   ↓
Planner
   ↓
Capability Router
   ↓
Execution
   ↓
Evaluator
   ↓
Adaptation
   ↓
Memory / Transfer
   ↓
Recovery / Safety
   ↓
Usage & Cost Awareness
   ↓
Repeat or Consolidate
```

---

## 5. Core Subsystems

### 5.1 Model / Eligibility Gate

Forge remains model-gated.

Requirements:

- Read active model identity from host/runtime metadata when available.
- Compare it against configurable allowed model slugs.
- Avoid permanently hardcoding one model slug.
- If the active model is not eligible:
  - do not call Forge MCP tools,
  - inform the user that Forge requires an eligible Astra model,
  - offer to continue without Forge or let the user switch models.
- Never claim that the plugin switched models automatically.

Suggested configuration:

```text
ASTRA_REQUIRED_MODEL=<configured slug>
ASTRA_ALLOWED_MODELS=<optional comma-separated slugs>
```

### 5.2 Adaptive Router

Inputs may include:

- complexity,
- uncertainty,
- continuity requirement,
- repeated failure,
- cross-domain scope,
- verification need,
- dependent-step count,
- risk and reversibility,
- expected capability usage,
- context-size estimate,
- expected iteration count.

Output:

```json
{
  "profile": "off|light|standard|deep",
  "cycleBudget": 0,
  "contextDetail": "none|summary|working|full",
  "usageImpact": "MINIMAL|LOW|MODERATE|HIGH|VERY_HIGH",
  "reasons": []
}
```

`cycleBudget` is a workflow limit only. It must never be presented as actual hidden reasoning-token usage.

### 5.3 Goal Graph

Each goal node should include:

```json
{
  "id": "goal-...",
  "parentId": null,
  "title": "string",
  "description": "string",
  "status": "pending|active|blocked|verified|abandoned",
  "priority": 0,
  "dependencies": [],
  "successCriteria": [],
  "createdAt": "ISO timestamp",
  "updatedAt": "ISO timestamp"
}
```

Capabilities:

- create root goals,
- split goals into subgoals/tasks,
- represent dependencies,
- identify blocked goals,
- mark goals verified only with supporting evidence,
- select the highest-value actionable node.

### 5.4 Epistemic State

Claim schema:

```json
{
  "id": "claim-...",
  "statement": "string",
  "status": "known|inferred|unknown|contradicted",
  "confidence": 0.0,
  "evidenceIds": [],
  "counterEvidenceIds": [],
  "scope": "project|goal|task",
  "scopeId": "optional id",
  "createdAt": "ISO timestamp",
  "updatedAt": "ISO timestamp"
}
```

Rules:

- confidence is not proof,
- known claims require evidence,
- inferred claims remain distinguishable from facts,
- contradictions trigger evaluation rather than silent overwrite.

### 5.5 Planner

Planner responsibilities:

- choose the next highest-value action,
- respect goal dependencies,
- reduce important uncertainty,
- prefer reversible and cheaper tests before broad changes,
- consider expected information gain,
- consider expected usage/cost,
- stop when success criteria are already verified.

Planner records should not store hidden chain-of-thought.

### 5.6 Capability Registry and Router

Forge reasons over capability categories rather than hardcoded plugin names.

Example categories:

- repository
- official documentation
- web research
- testing
- code review
- security analysis
- runtime diagnostics
- CI/CD
- data analysis
- file/document work
- design
- writing
- computation

Rules:

- use only capabilities actually exposed by the host,
- do not assume availability,
- prefer specialized capabilities when useful,
- persist only decision-relevant results.

### 5.7 Evaluator

Evaluator compares outcomes against explicit criteria.

Possible result states:

- verified
- partially verified
- inconclusive
- falsified
- blocked

### 5.8 Adaptation Engine

Failure categories:

- wrong hypothesis,
- missing information,
- implementation defect,
- test/evaluation defect,
- environment/tooling issue,
- misunderstood requirement,
- permission limitation,
- performance/resource limitation,
- conflicting evidence,
- external dependency.

The next plan must materially change when a previous strategy failed without new evidence.

### 5.9 Memory and Transfer

Memory layers:

**Project memory**
- project-specific facts and history.

**Verified lessons**
- reusable lessons validated by evidence.

**Transfer candidates**
- lessons from other projects that may be relevant but are not assumed valid.

Transfer rule:

> A cross-project lesson is a hypothesis until validated in the new context.

### 5.10 Recovery

Recovery scenarios include:

- tool failure,
- interrupted session,
- stale or malformed state,
- missing project files,
- permission denied,
- changed requirements,
- context switch,
- partially completed action.

Recovery should preserve valid state and continue from the safest meaningful next step.

### 5.11 Safety and Control

Requirements:

- never bypass permission prompts,
- never fabricate tool execution,
- distinguish recommendation from completed action,
- retain audit-friendly decision/evidence records,
- allow user override of routing mode,
- allow Forge to be disabled per project/session.

---

## 6. Usage & Cost Awareness

### 6.1 User-Facing Notice

> **⚠️ Usage & Cost Notice**  
> Astra Project Forge may increase overall model usage compared with using Astra without this plugin. This is because the plugin may perform additional planning, reasoning, project-state retrieval, tool calls, verification, evaluation, and multiple adaptive cycles when working on complex or long-running tasks.
>
> As a result, token usage, compute usage, or associated costs may increase, especially when using **Standard** or **Deep** modes. Astra Project Forge does **not** change the model’s base pricing; any increase comes from additional model and tool usage.
>
> For simpler tasks, Astra Project Forge will attempt to minimize overhead by using **OFF** or **LIGHT** mode when appropriate. For longer projects, selective context retrieval and persistent project state may also reduce repeated work and improve overall efficiency.
>
> **Use Astra Project Forge when the potential improvement in reliability, continuity, and problem-solving quality is worth the additional computational cost.**

### 6.2 Warning Placement

Show the notice in:

- README / installation documentation
- first activation
- first transition into `deep` mode

Do not show it every turn.

### 6.3 Usage Impact Indicator

Allowed values:

```text
MINIMAL
LOW
MODERATE
HIGH
VERY HIGH
```

Do not invent currency estimates unless real billing/usage telemetry is available.

---

## 7. State Schema v2

The v2.5 state uses schema version 1.

v2.6 migrates to schema version 2 without destroying old projects.

Proposed root:

```json
{
  "schemaVersion": 2,
  "projectId": "string",
  "goal": "legacy-compatible string",
  "mode": "standard|deep",
  "status": "active|consolidated|blocked",
  "successCriteria": [],
  "constraints": [],
  "goalGraph": [],
  "claims": [],
  "observations": [],
  "hypotheses": [],
  "experiments": [],
  "plans": [],
  "evaluations": [],
  "checkpoints": [],
  "lessons": [],
  "transferCandidates": [],
  "usage": {
    "lastProfile": "off|light|standard|deep",
    "lastUsageImpact": "MINIMAL|LOW|MODERATE|HIGH|VERY_HIGH",
    "deepWarningAcknowledged": false
  },
  "consolidation": null,
  "createdAt": "ISO timestamp",
  "updatedAt": "ISO timestamp"
}
```

Migration rules:

- never destroy v1 state,
- derive a root goal from the existing `goal`,
- preserve existing observations, hypotheses, experiments, checkpoints, and lessons,
- create missing arrays/objects lazily,
- write back as v2 only after successful validation.

---

## 8. MCP Tool Surface

Recommended primary v2.6 tools:

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

Compatibility:

- keep v2.5 `adaptive_*` tools available initially,
- treat them as compatibility aliases internally,
- do not break existing stored projects,
- consider deprecation only in a later major release.

---

## 9. Skill Behavior

Recommended trigger concept:

> Use when an eligible Astra model is handling work with meaningful complexity, uncertainty, dependent steps, iterative verification, long-horizon execution, cross-domain coordination, repeated failure, or a need for persistent project continuity.

The skill body should define:

- model eligibility,
- semantic activation,
- routing,
- selective memory,
- goal graph,
- epistemic state,
- planning,
- specialized capability coordination,
- evaluation,
- adaptation,
- transfer,
- recovery,
- usage/cost awareness,
- stop conditions.

---

## 10. Local-First Data Model

Preferred data directory resolution:

1. `ASTRA_PROJECT_FORGE_DATA_DIR`
2. `PLUGIN_DATA`
3. `~/.astra-project-forge`

Requirements:

- atomic writes,
- deterministic safe project filenames,
- no network sync by default,
- no hidden Forge telemetry,
- inspectable JSON state.

---

## 11. Licensing and Attribution

### 11.1 License Direction

v2.6 will move away from MIT.

**Planned license direction:**
- GNU Affero General Public License v3.0 (AGPL-3.0)
- plus carefully drafted attribution/notice requirements where legally compatible

This licensing section is a project-design direction, not legal advice. Final wording should be reviewed before release.

### 11.2 No Trademark Policy Yet

Astra Project Forge does **not** currently include a dedicated trademark policy in v2.6.

Do not add:

```text
TRADEMARKS.md
```

and do not represent the project name as a registered trademark unless that status actually exists.

### 11.3 Required Files

v2.6 should include:

```text
LICENSE
NOTICE.md
ATTRIBUTION.md
README.md
```

### 11.4 Attribution Principle

Attribution requirements should scale with the amount and role of Astra Project Forge material that is reused.

Changing the downstream project name does not remove attribution or license obligations for Astra Project Forge material that remains in that work.

### 11.5 Attribution Tiers

#### Tier A — Direct Fork

Applies when a project is a direct fork or close derivative of Astra Project Forge.

Suggested wording:

> **Derived from Astra Project Forge.**  
> This software is a modified derivative of Astra Project Forge.

Expected attribution:
- prominent credit in README or equivalent documentation,
- preserve applicable copyright/license notices,
- clearly state that the version is modified,
- retain `LICENSE`, `NOTICE`, and applicable attribution information.

#### Tier B — Substantial Derivative

Applies when Astra Project Forge code or architecture forms a substantial part of the downstream implementation.

Suggested wording:

> **This project contains substantial portions derived from Astra Project Forge.**

Expected attribution:
- clear project-level acknowledgment,
- identify that substantial Forge-derived material is present,
- preserve applicable notices.

#### Tier C — Multiple Components

Applies when multiple Forge components or subsystems are incorporated into another project.

Suggested wording:

> **This project incorporates components derived from Astra Project Forge.**

Expected attribution:
- identify the relevant Forge-derived components where practical,
- preserve notices associated with those components,
- no requirement to imply that the entire downstream project is based on Forge if that would be inaccurate.

#### Tier D — Single Component / Module

Applies when one Forge subsystem, module, or file group is reused.

Suggested wording:

> **This project includes a component derived from Astra Project Forge.**

Expected attribution:
- attribution in README, NOTICE, documentation, or the relevant source area,
- preserve license/copyright notices attached to the reused material.

#### Tier E — Small Code Portion

Applies when a smaller but still meaningful portion of Forge code is copied or adapted.

Suggested wording:

> **Contains code derived from Astra Project Forge.**

Expected attribution:
- preserve applicable notices,
- attribution may be placed locally in source headers, NOTICE, or documentation,
- project-wide “based on” wording is not required.

#### Tier F — Tiny / Incidental Portion

Applies to very small portions where attribution is still applicable to copied protected material.

Expected attribution:
- preserve any existing legal/copyright notice that accompanies the copied material,
- do not require a prominent whole-project attribution when that would exaggerate Forge’s contribution.

#### Tier G — Unmodified Redistribution

Applies when Astra Project Forge is redistributed essentially unchanged.

Requirements:
- preserve project name,
- preserve applicable copyright notices,
- preserve `LICENSE`,
- preserve `NOTICE.md`,
- preserve `ATTRIBUTION.md`,
- do not present the redistribution as an independently authored original.

#### Tier H — Modified Redistribution

Applies when Forge is repackaged or modified and redistributed.

Requirements:
- preserve original attribution,
- clearly disclose that the version has been modified,
- preserve applicable license and notice files.

#### Tier I — Commercial Distribution

Commercial use does not remove attribution or license obligations.

Selling, bundling, or monetizing a derivative does not permit removal of Forge attribution from covered Forge-derived material.

#### Tier J — Hosted / Network Use

Where AGPL obligations apply, hosted modified versions must comply with the applicable AGPL source-availability requirements.

Attribution for Forge-derived material should remain clear and appropriate to the degree of reuse.

#### Tier K — Independent Reimplementation

If another developer independently creates software with similar functionality **without copying or deriving protected Astra Project Forge source material**, Forge’s source-code license does not automatically apply merely because the functionality is similar.

#### Tier L — Ideas / Concepts Only

Using general ideas, patterns, architectural concepts, or independently implemented workflows without copying Forge source material is different from incorporating Forge code.

Attribution may still be appreciated, but the code license should not falsely claim ownership over independently created ideas or functionality.

### 11.6 Attribution Must Be Proportional

The policy should avoid artificial percentage thresholds.

Do not define rules like:

```text
20% of code = substantial derivative
```

Instead, consider:
- role of the reused code,
- importance of the component,
- whether Forge code forms a core subsystem,
- whether the downstream work is materially derived from Forge.

### 11.7 Example Attribution Snippets

**Direct fork**
```text
Derived from Astra Project Forge.
This project is a modified version of Astra Project Forge.
```

**Several components**
```text
This project incorporates components derived from Astra Project Forge.
```

**Single component**
```text
This project includes a component derived from Astra Project Forge.
```

**Small portion**
```text
Contains code derived from Astra Project Forge.
```

**File-level**
```text
Portions of this file are derived from Astra Project Forge.
See LICENSE and NOTICE for applicable terms.
```

---

## 12. Testing Strategy

Implementation must be test-first.

Minimum test families:

### State migration
- v1 loads without data loss
- migration creates v2 fields
- failed migration does not corrupt the original state

### Goal graph
- root/subgoals
- dependency enforcement
- invalid references rejected
- verified status requires evaluation evidence

### Epistemic state
- known requires evidence
- inferred remains distinct
- contradictions retained
- confidence validation

### Router
- trivial task → `off`
- modest task → `light`
- complex/high-uncertainty task → `standard` or `deep`
- usage impact scales appropriately
- cheapest viable profile is preferred

### Planner / evaluator
- blocked dependency not selected
- reversible evidence-gathering preferred where appropriate
- evaluator detects missing criteria
- stop condition triggers when verified

### Adaptation
- failed identical strategy is not repeated without new evidence
- failure category recorded
- next strategy materially changes

### Transfer
- cross-project lesson begins as candidate
- candidate can be validated in the new project
- unrelated lessons are not injected

### Recovery
- interrupted project resumes from checkpoint
- permission denial becomes a blocker, not a bypass
- malformed optional state is handled safely

### Usage / cost notice
- first-use notice state recorded
- deep-mode notice occurs once
- no fabricated price estimate

### MCP compatibility
- initialize handshake
- tools/list
- all v2.6 tool schemas
- legacy adaptive tools remain functional
- stdio works from arbitrary workspace paths

---

## 13. Non-Goals for v2.6

Do not add:

- model-weight training,
- autonomous self-modification,
- hidden chain-of-thought storage,
- unsupported billing estimates,
- uncontrolled background execution,
- permission bypass,
- claims that Forge creates AGI,
- forced use of every available plugin,
- required cloud sync,
- a trademark policy that implies registered trademark status.

---

## 14. Success Criteria

v2.6 is complete when:

1. v2.5 projects load without loss.
2. Goal graph and epistemic state are persisted.
3. Forge routes tasks using smallest-useful-workflow logic.
4. Selective context remains the default.
5. Planning and evaluation are separate from observations.
6. Failure causes produce adaptive strategy changes.
7. Transfer lessons remain hypotheses until validated.
8. Recovery works across interruption and denied capabilities.
9. Usage impact is surfaced without pretending to know exact billing.
10. Usage & Cost Notice exists in universal English.
11. Existing MCP stdio startup remains stable.
12. Legacy `adaptive_*` calls remain functional.
13. No claim implies AGI or model-weight retraining.
14. AGPL licensing direction is reflected in release files.
15. Tiered attribution rules are documented.
16. No trademark policy is added yet.
17. Full automated test suite passes.

---

## 15. Planned Release Files

```text
plugins/astra-project-forge/
├── .codex-plugin/
├── .mcp.json
├── LICENSE
├── NOTICE.md
├── ATTRIBUTION.md
├── README.md
├── server/
├── skills/
├── tests/
└── package.json
```

---

## 16. Implementation Sequencing

After this specification is approved:

1. write implementation plan,
2. add failing migration/state tests,
3. implement schema v2 migration,
4. add goal graph,
5. add epistemic state,
6. extend routing with usage impact,
7. add planner/evaluator/adaptation,
8. add transfer/recovery,
9. add MCP v2.6 facade + compatibility aliases,
10. update skill/README/usage warning,
11. add AGPL/NOTICE/ATTRIBUTION release files,
12. run full regression and stdio integration tests,
13. package local plugin + marketplace ZIP.

No production implementation should begin before the implementation plan is reviewed.
