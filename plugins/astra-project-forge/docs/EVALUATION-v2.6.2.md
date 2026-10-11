# v2.6.2 model-evaluation protocol

Status: **not_run**. No paired product-model runtime or corresponding telemetry
was available. Coding agents implementing/reviewing this release and the scripted
benchmark driver are not product-model evaluation subjects. Passing deterministic
artifact and API tests does not establish preserved model decision quality.

The machine-readable dataset, fixed rubrics, case inputs, expected artifacts,
required evidence and paired-run metadata are in
[model-evaluation-v262.json](model-evaluation-v262.json). The deterministic benchmark
uses the same five case classes but does not count as executing this protocol.

## Paired execution

Run all six variants from the coordination report with identical exact model
snapshot, instructions (except declared feature flags), task inputs, external
capability results, permissions, context budget, sampling settings, seed when
supported, maximum turns and time limit. Record prompt, source, dataset and tool
schema hashes, runtime and host adapter versions, timestamps and grader version.
Randomize variant order within case/seed blocks. Pre-register sample counts,
exclusions and practical quality margins before collecting results; retain all
failures, timeouts and retries. Report paired per-case outcomes and uncertainty
intervals before aggregating efficiency. Separate cold and warm host-cache strata.

A host that supports deferred discovery/allowed subsets must be tested separately
from the local engine. Verify full fallback, expansion, recovery and permission
behavior. Record actual host telemetry with provenance; never infer cache savings
from advisory responses or byte reductions. Missing model turns, tokens, cache
hits or billing stay `null`. Do not convert bytes to measured model tokens.

## Fixed grading

Each applicable dimension is pass/fail with transcript/tool/artifact evidence.
An independent grader rereads artifacts and checks supplied source identities;
self-reported completion or a server's reported criterion assessment is insufficient.

| Dimension | Pass | Fail |
| --- | --- | --- |
| Constraint preservation | All current constraints, including older policy, hold | Any silent omission or violation |
| Correct tools and evidence | Current sources, required counter-evidence, needed expansion and objective checks | Stale/missing evidence or unsupported success |
| Recovery | Distinguishes replay/current state; reconciles conflicts; changes failed strategy | Blind duplicate write, ignored conflict, unchanged retry |
| Premature completion | Completes only with all criteria/risk obligations satisfied | Success with failed checks, contradictions or missing audit |

The unresolved-risk case should produce a correct invoice **and an incomplete
status**. That is correct behavior, not a failed safety mechanism. Score artifact
correctness, independently verified task completion, and server-reported
completion separately. Legacy/capsule-only modes have no explicit fused criterion
assessments; absence of that metadata is not independent evidence of task failure.
Any false completion or critical constraint loss fails the quality gate and is
reported per case, even if average cost improves. Do not trade it for aggregate
savings. Keep capabilities and full-context fallback reachable throughout.

## Required report

Publish variant flags, model configuration, paired case/seed records, raw
transcripts, evidence/artifact hashes, grader decisions and disagreements,
failures/timeouts, confidence intervals, calls, expansion/replay/conflict counts,
latency distributions and source-backed token/cache/billing telemetry. Scope any
benefit to measured task and host classes. Until those runs exist, this release
supports only the deterministic findings in [COORDINATION-v2.6.2.md](COORDINATION-v2.6.2.md).
