# Compact Control Responses

This is an opt-in, unpublished 2.6.1 follow-up. The verified baseline is commit
`cd0edae9921c80784e11ce3bcaec57f29c224786`; identify a candidate by its commit and
content hashes. Both carry version `2.6.1`; this is not a new published release.

## API Contract

Only `forge_route`, `forge_plan`, `forge_observe`, and `forge_evaluate` gain this
control-response option:

| `resultLevel` | Behavior |
| --- | --- |
| Omitted or `full` | Existing complete response. |
| `summary` | Response-only projection using the omission list below. |

On these four controls, `relevant` is invalid, as are null, non-string values,
and other strings. Validation happens before any mutation. `forge_context`
retains its separate `summary`, `relevant`, and `full` result levels and its
existing detail/cursor rules. The 19 tools and legacy APIs are unchanged.

Projection does not change persisted records, route decisions, ledger events,
cache freshness or invalidation, or error responses. Errors remain unchanged.
Soft-budget logic, justify-before-spend, failed-strategy guards, risk-scaled
verification, usage notices, and stopping after verified success are unchanged.
Selecting summary does not authorize extra work or bypass any safety check.

## Exact Omissions

These fields are omitted only from the named records under `structuredContent`
in successful summary responses. The authority is `server/control-results.mjs`.

| Tool | Record | Fields omitted |
| --- | --- | --- |
| `forge_route` | `route` | `score`, `complexity`, `uncertainty`, `expectedIterations`, `contextDetail`, `cycleBudget` |
| `forge_plan` | `plan` | `action`, `why`, `expectedEvidence`, `createdAt` |
| `forge_observe` | `observation` | `observation`, `evidence`, `createdAt` |
| `forge_observe` | `claim` | `createdAt`, `updatedAt` |
| `forge_observe` | `transferCandidate` | `createdAt`, `updatedAt`, `relevance` |
| `forge_observe` | `evidenceRecord` | `result` |
| `forge_evaluate` | `evaluation` | `createdAt` |

Explicit null values, including nulls in the listed fields or entire records,
are preserved. All unlisted and unknown fields are preserved, as are the MCP
text content, wrapper keys, IDs, revisions, and record references.
Route `guidance` and `reasons` remain, including off, stop, and justification
guidance. `stateDetail` and `softCycleBudget` retain their existing values.
Safety decisions, concrete budget overrides and provenance, evidence IDs,
evaluation summaries, and missing criteria remain available.

Observation registration omits the acknowledged `evidenceRecord.result` only
from its response. Cache retrieval through `forge_route` or `forge_plan` keeps
`evidenceRecord.result`: the full retrieved result is retained, including
verification details. A cache-hit `plan: null` also remains null.

## Opt-In Examples

These are MCP `tools/call` params. The project must already exist. Each call
performs its normal operation once and selects a smaller acknowledgement.

```json
{"name":"forge_route","arguments":{"projectId":"example-project","complexity":"moderate","resultLevel":"summary"}}
```

```json
{"name":"forge_plan","arguments":{"projectId":"example-project","action":"Inspect the focused test log","why":"Determine which criterion remains unmet","expectedEvidence":"Test result and missing criteria","usageImpact":"LOW","resultLevel":"summary"}}
```

```json
{"name":"forge_observe","arguments":{"projectId":"example-project","operation":"observation","observation":"The focused tests passed","evidence":"focused-test.log","resultLevel":"summary"}}
```

```json
{"name":"forge_evaluate","arguments":{"projectId":"example-project","outcome":"inconclusive","summary":"Full regression verification remains pending","missingCriteria":["Full suite passes"],"resultLevel":"summary"}}
```

Omit `resultLevel` or set it to `full` on the original call when its complete
response is needed immediately.

## Read-Only Recovery

Do not re-run a mutation merely to recover fields omitted from its response.
Read the complete persisted project instead; omit `sinceRevision`:

```json
{"name":"forge_context","arguments":{"projectId":"example-project","detail":"full","resultLevel":"full"}}
```

The project is at `structuredContent.context.project`. Complete records are in
`plans`, `observations`, `claims`, `transferCandidates`, and `evaluations`;
match IDs retained in the summary. Cached results are in
`efficiency.evidenceCache`. The latest persisted route is at
`efficiency.lastRoute`, not a complete route history. A later project route
replaces that latest route. Projection does not introduce historical snapshots.

The existing read-only legacy alternative returns `structuredContent.project`:

```json
{"name":"adaptive_get_state","arguments":{"projectId":"example-project"}}
```

For full recovery output, `forge_context` also accepts `detail: "recovery"`
with `resultLevel: "full"` and no cursor. Recovery detail without an explicit
result level retains its existing selective recovery response; use the explicit
full option above when complete stored records are required.

### Projectless Route Exception

A `forge_route` call without `projectId` is stateless: its route is not persisted.
You cannot recover its omitted fields through project context. Request `full`
(or omit `resultLevel`) on that call, or recompute the stateless route using the
same inputs and full output. Recomputing is a new result, not historical recovery.

```json
{"name":"forge_route","arguments":{"complexity":"moderate","resultLevel":"full"}}
```

## Three-Way Benchmark

Run `npm run benchmark:efficiency` from the plugin or either package extraction.
The package-local runner uses Node.js built-ins, isolated temporary stores,
and the same ordered workload candidates, seeded files, expected artifacts,
and completion checks across these modes:

| Mode | Runtime and responses |
| --- | --- |
| `v260_baseline` | Immutable v2.6.0 source at `267870465ef6c5fe69512c3d217d632f51c6b0af`. |
| `v261_verified` | Immutable verified `cd0edae` source with default full control responses. |
| `v261_compact` | Current production with summary responses on the four controls. |

Both v2.6.1 modes retain the same existing summary/delta context requests and
workload/control sequence. The legacy `v261_efficiency` runner API continues to
use current production with full control responses. Frozen source and legal
bytes ship with both layouts; `tests/fixtures/v261-verified/provenance.json`
records the verified commit, extraction method, and SHA-256 hashes.

The six workloads cover duplicate evidence, useful work beyond a soft budget,
changed dependencies, unresolved risk, unchanged retries, and context resume.
Artifact correctness and verification are separate: unresolved risk must not
be certified as verified success merely because the artifact is correct.

Byte costs are UTF-8 `JSON.stringify` sizes at the actual MCP dispatch boundary:
`coordinationRequestBytes` includes opt-in arguments;
`coordinationResponseBytes` includes content, structuredContent, wrappers, and
errors; `coordinationCombinedBytes` is their sum. Transport-envelope bytes are
excluded. `contextBytes` is a response subset and is not added again. Context
units count primitive/null leaves, not tokens. Named pairwise deltas are the
later mode minus its named baseline; totals sum the six runs per mode.

The runner distinguishes workload calls/cycles, useful actions, duplicate
calls, consumed evidence reuse, retries, MCP coordination calls, and harness
operations. Total tool calls combine workload and coordination calls; total
operations also include harness operations. These are not model-turn counts.

Timing is one run per workload/mode, a variable local sample rather than a
statistical latency study. Elapsed time spans worker startup through cleanup
and exit; work, coordination, and harness timings cover disjoint operations,
with other time including startup, serialization, and driver overhead.
Results are not a speed or token-savings guarantee. Model turns, model tokens,
host cache hits, and billing remain unavailable (`null`); store evidence reuse
is not host cache telemetry. Smaller control responses alone do not establish
lower combined costs than v2.6.0, lower compute usage, or lower model charges.
Record actual byte/count/timing samples and runtime details in verification
reports, not universal performance claims.

## Packaging

Build both layouts with the existing `npm run package:release -- --output-dir
/absolute/path/to/new-candidate-directory` command (on one line). Choose a new
unique directory outside the repository; never overwrite the original verified
archives or evidence. Both layouts include the projection, three-way runner,
immutable fixtures with legal/provenance files, this guide, and its contract
tests. Ignored scratch and local state must not ship. Building archives does
not replace final review and fresh extraction checks.
