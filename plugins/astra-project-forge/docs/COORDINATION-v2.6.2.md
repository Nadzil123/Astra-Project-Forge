# v2.6.2 coordination: verification and limits

The approved design is [DESIGN-v2.6.2.md](DESIGN-v2.6.2.md). The API contract and
examples are in [TOOLS.md](TOOLS.md). These options preserve the 19-name public
catalog and remain disabled unless requested. Independent artifact verification,
reported criterion assessments, and model decision quality are different claims.

## Changes

- Atomic reported evaluation combines explicit evidence, criterion/claim updates,
  invalidation and reported ledger events in one transaction. It never infers
  criterion satisfaction from `outcome: "verified"` alone. Claim assessments pin
  statement/evidence content and version; replacement requires explicit reassessment.
- Evaluation failures remain within their applicable goal scope. A corrected plan
  for that goal can resolve an earlier failure. Ambiguous/unscoped history needs a
  new complete, supported fused project reassessment; unrelated success or replay
  cannot clear it. Other completion blockers remain independent.
- Expected revision and epoch reject conflicting new operations; identical
  operation IDs replay their historical response after a lost reply. Capsule
  replay context is separately labeled `currentDecisionCapsule`. Public conflicts
  retain legacy text/isError and add code, current identity and full-context resync
  guidance; no automatic retry or semantic merge occurs.
- Decision Capsules retain mandatory constraints, uncertainty and risk, use
  heuristic selection, and expose references/incomplete/resync information.
  Explicit reference expansion and full/recovery context remain reachable.
- `includeContext` combines routing and context delivery. Optional host capability
  selection is advice only; it does not enable host discovery, permissions or
  prompt caching. The stable catalog always includes all 19 tools.

## Frozen baseline and exact flags

The uploaded baseline is `astra-project-forge-local-marketplace-2.6.1.zip`, SHA-256
`f84fc8a14e4ff75b9c632f4630982bc77a1a1c9b666f859badd96330def5fbcf`.
`tests/fixtures/v261-uploaded/provenance.json` pins its original runtime bytes.
The preexisting v2.6.0 and verified v2.6.1 fixtures and v261 harness remain intact.
The JSON report records runtime source hashes, workload hash and variant flags.

| Variant | Source | Controls | Per-step context | Fused evaluate | Host advice |
| --- | --- | --- | --- | --- | --- |
| v261_uploaded_full | Frozen uploaded ZIP | Omitted/full | working/relevant | No | No |
| v261_uploaded_compact | Same frozen upload | summary | working/relevant | No | No |
| v262_legacy | Current | Omitted/full | working/relevant | No | No |
| v262_fusion | Current | Omitted/full | working/relevant | Yes | No |
| v262_capsule | Current | capsule | separate capsule | No | No |
| v262_combined | Current | capsule | route.includeContext | Yes | Advisory request on every route |

`includeContext` returns a capsule, so only combined mode uses it. Fusion-only
keeps legacy working/relevant context for the ablation; it uses the initial full
state epoch and returned plan revision for each atomic proposal. These actual
support responses are included in the totals. Fusion submits explicit assessments that
legacy evaluation never stored. Comparing structural completion across these
modes as if all stored identical assessments would be misleading. The benchmark
reports it separately: unavailable (`null`) in uploaded and v262 legacy modes;
capsule-only can report false despite independently verified artifacts.

## Workloads and quality floor

All variants execute the same ordered file work, constraints and checks:

| Case | Independent expected invoice | Required behavior | Verified success |
| --- | --- | --- | --- |
| ordinary | USD 17 | Read both inputs, build, verify | Yes |
| old-constraint-counter-evidence | USD 17 | Expand policy proof, read policy, resolve contradictory claim | Yes |
| changed-dependency | USD 22 | Change and reread input; invalidate old evidence; verify current output | Yes |
| unresolved-risk | USD 17 | Report missing mandatory risk audit despite correct invoice | No |
| recovery-retry | USD 17 | Reject unchanged failed verify; repair; recover uncertain reply | Yes |

The oracle rereads final files, recomputes totals, checks USD/no-discount policy,
and validates verification identities against current artifact/source/policy
hashes. It does not trust server success or the evidence's `passed` flag. Tests
also corrupt the artifact, currency, source or verification to prove rejection.
Recovery simulates response loss at the driver boundary after a real commit;
fusion replays the original request, rejects a new stale operation, then reads
current state. Legacy reads persisted state to reconcile an uncertain reply.
This is not a process-crash or power-loss benchmark. Focused persistence tests
cover additional lock/recovery and transactional failure cases.

## Counting and reproduction

```bash
npm run check
npm test
npm run --silent benchmark:efficiency > benchmark-v262.json
npm run benchmark:efficiency:v261
```

The new runner uses real production/frozen `dispatch` calls in isolated workers
and temporary stores through `processRpcMessage`. Every request and full response
is retained, including the actual JSON-RPC envelopes, with actual
UTF-8 JSON byte lengths. Setup, `initialize`, `tools/list`, usage acknowledgement,
support reads, reference/full expansion, host advice, errors, retry, replay and
conflict are counted. `coordinationCalls` includes discovery/initialize;
`coordinationToolCalls` counts only `tools/call`. These are not model turns.

The serialized JSON includes `jsonrpc`, `id`, and `result`/`error` envelopes.
Stdio newline delimiters (one byte per request and per response) are excluded;
OS pipe transport is not timed. Context bytes include context,
recovery and attached capsules and are already part of response bytes. A verify
work call reads the artifact, both source files and policy; work calls count
logical capability invocations, not filesystem syscalls. No filler work is added.

Three fresh workers/stores per case/variant record repeated elapsed latency and
all raw traces. Dispatch timing includes locking, serialization and file I/O;
whole-worker elapsed includes startup, setup, useful work, independent checks and
cleanup. Final store bytes include replay receipts and ledger/reference metadata.
Counts/bytes/storage totals use the first repetition; every repetition is kept.
UUIDs and timestamps are not normalized before measurement. Fixed variant order,
local filesystem caching and only three samples limit timing interpretation.
Maximum-of-three is a descriptive tail sample, not a production percentile.

## Measured results

Measured on Node v24.19.0, Linux x64, 9 October 2026. Counts,
bytes and storage below sum the first sample of each of five cases. All variants
execute 25 useful work calls, produce five correct artifacts, independently verify
four cases, and correctly leave the missing-audit case incomplete. There are zero
false-completion observations in all 90 runs (three repetitions × five cases × six
variants). Structural completion is unavailable in uploaded/legacy responses,
false in capsule-only (no explicit assessments), and true for four cases in the
fusion and combined modes.

| Variant | Coordination calls | Request bytes | Response bytes | Combined bytes | Store bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| v261_uploaded_full | 191 | 70,964 | 559,755 | 630,719 | 92,338 |
| v261_uploaded_compact | 191 | 73,460 | 542,928 | 616,388 | 92,338 |
| v262_legacy | 191 | 70,964 | 588,858 | 659,822 | 93,300 |
| v262_fusion | 141 | 69,010 | 620,921 | 689,931 | 166,738 |
| v262_capsule | 191 | 73,178 | 1,073,906 | 1,147,084 | 93,300 |
| v262_combined | 116 | 68,884 | 853,820 | 922,704 | 166,738 |

The uploaded compact baseline is the primary practical comparator: 191 calls,
616,388 combined bytes and 92,338 store bytes. Fusion uses 141 calls but 689,931
combined bytes and 166,738 store bytes; combined uses 116 calls but 922,704 combined
bytes and the same 166,738 store bytes.

For an ablation within the current engine, fusion saves 50 calls against legacy
in this workload but increases combined
bytes from 659,822 to 689,931. Combined saves 75 calls but increases bytes to
922,704. Capsule-only reaches 1,147,084 bytes. None of the new modes beats the
uploaded compact baseline's 616,388 total bytes here. These results support a
call-count benefit for fused administrative updates, not a wire-byte improvement
on these small project states. Fusion/combined also store 166,738 bytes compared
with legacy's 93,300 bytes, including durable replay responses.

The following are sums of the five case elapsed times at each repetition index;
the median and maximum summarize only those three suite samples.

| Variant | Suite elapsed samples (ms) | Median (ms) | Maximum (ms) |
| --- | --- | ---: | ---: |
| v261_uploaded_full | 989.0, 835.6, 970.2 | 970.2 | 989.0 |
| v261_uploaded_compact | 900.2, 1004.0, 1000.5 | 1000.5 | 1004.0 |
| v262_legacy | 1649.3, 1964.6, 1566.6 | 1649.3 | 1964.6 |
| v262_fusion | 1723.2, 1314.3, 1704.4 | 1704.4 | 1723.2 |
| v262_capsule | 1942.0, 2238.9, 1995.1 | 1995.1 | 2238.9 |
| v262_combined | 1742.4, 1696.6, 1712.1 | 1712.1 | 1742.4 |

The v2.6.2 latency/storage costs are visible; these samples do not establish a
speed benefit over the uploaded baseline. Each variant has one policy expansion,
one unchanged-strategy error and two recovery calls. Fusion/combined additionally
include one replay and one revision-conflict error; combined includes 25 advisory
responses. None of these costs is removed from the totals.

Verification after the final review fixes: `npm run check` passed and the seven
covering test files passed 88/88 tests, including all 10 v262 benchmark tests.
The earlier 410/410 full-suite result predates these corrections; final full-suite
and extracted-archive gates are controller-owned and are not claimed here.
The refreshed benchmark contains all 90 runs and zero quality regressions;
3,063 serialized request/response pairs reconcile to recorded bytes, and all
24 recorded runtime source hashes match the measured files. Its raw JSON SHA-256 is
`10aaaab6e1b184360e90b606130eca089e8a14d41e6ba26a95d65011108386f7`. The workload SHA-256 is
`6e7f382c3a185c226a25a251c0588429d75df408f95ec2fb37e4f98534f274a9`.
The original Task 5 measurement is retained separately as historical evidence.
No model evaluation was run.


Do not infer a universal saving from call counts or bytes. Capsule responses may
cost more on small states and reference-heavy safety context. Durable coordination
and replay metadata increase storage; local locking and syncing add latency.
Any worsening metric remains part of the report. Savings, where observed, apply
to these administrative coordination workloads, not model tokens or quality.

## Persistence and deployment limits

Transactions serialize cooperating writers on a single local host. Conservative
owner checks fail closed when recovery cannot prove ownership; dead or unprovable
recovery guards require manual inspection/recovery. This is not a distributed
lock or a universal power-loss, network-filesystem, or hostile-writer guarantee.
Keep full-context recovery and legacy behavior available. New capsule and host
advice modes are opt-in while model/host evaluation is unrun.

No real model runtime was available. Model turns/tokens, host cache hits, billing
and paired quality results are `null`/`not_run`. See [the fixed model protocol](EVALUATION-v2.6.2.md).
