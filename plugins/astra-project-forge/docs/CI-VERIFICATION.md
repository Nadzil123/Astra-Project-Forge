# Native Linux Verification

The repository-root `Native Verification` workflow is a manual validation setup,
not evidence that a candidate has passed. The controller publishes the reviewed
workflow to the existing default branch, then selects it in GitHub Actions and
supplies `candidate_sha`: an existing same-repository commit's full lowercase
40-hex SHA. Empty input uses the dispatch SHA. This creates no branch and does
not automatically promote code to main. GitHub requires the manual workflow to
exist on the default branch; see [workflow_dispatch documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch).

The runner is native `ubuntu-24.04` with Node 22 and a 20-minute job limit.
This supplies a native Linux contrast to local PRoot results; it does not
reinterpret or hide PRoot deadline failures. No existing test assertion or
timeout is changed. There are no provider calls, credentials, or model campaigns.

SHA validation precedes checkout. The runner checks that `git rev-parse HEAD`
equals the requested SHA and requires both `git diff --exit-code` and
`git diff --cached --exit-code` to pass before verification. It records the actual
SHA, Node version, platform, architecture, and SHA-256 hashes of the plugin's
`LICENSE`, `NOTICE.md`, and `ATTRIBUTION.md`. Both tracked-clean checks run again
after verification, including after a gate failure; a clean final check cannot
erase an earlier failure.

The root configuration gate is
`node --test tests/ci-workflow.test.mjs tests/ci-portability.test.mjs`.
Then, from `plugins/astra-project-forge`, the gates are unchanged `npm run check`,
complete `npm test`, and `npm run benchmark:efficiency`. Once source identity
succeeds, all four gates run even when another fails. Each retains its exit code
and separate full stdout/stderr logs, with only the last 40 lines per stream
printed to the console. Root CI tests intentionally remain outside the plugin
package so standalone plugin tests need no parent checkout.

Logs and metadata live only in `$RUNNER_TEMP/forge-verification/`. The
`native-verification` artifact upload is always attempted, requires files, and
retains them for seven days. Review the source metadata, all gate exit-code
files, final tracked-clean result, and full logs for the exact candidate SHA.
An interrupted or timed-out run is incomplete evidence. These verification
artifacts are not measured model telemetry: the benchmark is local deterministic
coordination and file work, with no billing, model quality, or model savings claim.

Actions are pinned to these compatible v4 commits:

- `actions/checkout@11d5960a326750d5838078e36cf38b85af677262`, without persisted
  credentials, with fetch depth 1 and no safe-directory setting.
- `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020`, Node 22.
- `actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02`.

See the official [checkout inputs](https://github.com/actions/checkout) and
[artifact upload inputs and retention](https://github.com/actions/upload-artifact).
The workflow has only `contents: read` permission and no automatic triggers,
deployment, publishing, cache, or promotion step. Actual GitHub Actions runs and
publishing are controller-owned after independent reviews.

## Optional Fresh-Source Gate

The boolean dispatch input `verify_portability` defaults to `false`. Set it to
`true` to run an additional independent gate after the normal gates and final
tracked-source check. Both the SHA and the literal `true`/`false` boolean are
validated before checkout using environment variables; input values are never
inserted into shell bodies. After source identity succeeds, the optional gate
runs even if another gate fails. Existing failures keep their original result.

The root script `.github/scripts/verify-portability.mjs` reads only the selected
commit's plugin tree with local Git object commands. It never fetches or copies
the working tree. It checks each blob's object identity and rejects links,
submodules, traversal, ambiguous paths, and `.git`/`.superpowers` entries before
execution. Regular source files, including hidden files and executable modes,
are copied into a uniquely owned directory outside the checkout. This is source
verification, not release packaging. No plugin script depends on root `.github`
infrastructure, Git history, or an SDD workspace.

Before execution it retains the exact committed tree and a complete SHA-256
file manifest, compares the extracted manifest to that committed source, and
asserts the original `LICENSE`, `NOTICE.md`, and `ATTRIBUTION.md` hashes and
`AGPL-3.0-only` package metadata. It records actual Node/platform/architecture
and package metadata. From the extracted package it runs, without modifications:

- `npm run check`
- `npm test` (complete suite)
- `npm run benchmark:efficiency`
- `npm run benchmark:routing:self-test`

Each command keeps its real status and separate complete stdout/stderr files.
An inner failure does not stop the other independent gates or MCP discovery;
the portability gate ultimately returns the first failure's exit code. Spawn
errors/signals are recorded and fail the gate. A final manifest check detects
changed, missing, or added source files, even after an inner failure.

Stream acquisition is protected too: an open failure records the attempted
command as failed and closes every acquired descriptor before continuing other
independent gates. Each close is attempted separately. `error` preserves the
primary failure; `closeErrors` retains any additional close failures. An
unopened stream has a `null` path, not a claimed retained log. If evidence storage
itself cannot be written, verification fails closed; missing artifacts cannot be
treated as complete evidence.

Four separate stdio probes launch the extracted absolute MCP entrypoint from an
unrelated directory: advice `off`/`advisory-v1`, each with default eligibility and
an explicit dual-policy fixture. Each initializes and discovers the exact nine
`forge_*` and ten `adaptive_*` tools, checking advice negotiation/schema presence.
Home, temporary files, npm configuration/cache, and per-probe data are isolated.
Inherited routing/eligibility settings and credentials are not passed to these
commands. No tool execution or real model execution occurs; the dual fixture
changes no global eligibility. A requested transition is never an observed switch.

The script removes only its own uniquely created scratch tree in `finally`,
including failures. Caller-supplied source/evidence paths are never recursively
deleted. As with other job gates, cancellation or timeout is incomplete evidence.

## Portability Evidence

The existing always-uploaded `native-verification` artifact additionally contains:

- `portability.stdout.log`, `portability.stderr.log`, `portability.exit-code`:
  outer workflow gate output and real exit.
- `portability/receipt.json`: candidate SHA, actual `metadata`, `package`,
  `legalHashes`, `manifestSha256`, `sourceUnchanged`, `commands`, `discovery`,
  `errors`, `exitCode`, `scratchDirectory`, `sourceDirectory`, and `cleanup`.
  Unknown model/billing `telemetry` is `null`. Precondition failures can omit
  fields for stages that were never reached; they cannot count as success.
- `portability/committed-tree.json`: `{file, mode, oid}` for every regular source
  entry in the exact commit. `manifest.committed.json`, `manifest.before.json`,
  and `manifest.after.json` contain sorted `{path, mode, sha256}` records. The
  receipt's `manifestSha256` hashes the exact bytes of `manifest.before.json`.
- `portability/commands.json`: the complete ordered command ledger, also embedded
  in the receipt. Each entry records `command`, `args`, `cwd`, `exitCode`, raw
  `status` (nullable), `signal`, `error`, `closeErrors` (an array of
  `{stream,message}`), and relative `stdout`, `stderr`, `exitFile` filenames.
  `stdout`/`stderr` are `null` if that stream could not be opened.
  `commands/0000.stdout.log`, `commands/0000.stderr.log`, and
  `commands/0000.exit-code` start the sequential per-command evidence, including
  all Git object reads, npm gates, and stdio probes. Output streams go directly
  to disk without a capture-buffer truncation limit.
- `portability/discovery.requests.json`: the initialize/initialized/tools-list
  messages sent to each probe. Each receipt `discovery` entry records `policy`,
  `mode`, `cwd`, `entrypoint`, `dataDirectory`, fixture `eligibility` (or `null`
  for defaults), `commandIndex`, `tools`, and `verified`. Raw replies remain in
  that command's full stdout log.

A passing receipt requires `exitCode: 0`, empty `errors`, `cleanup: "removed"`,
`sourceUnchanged: true`, matching manifests/legal hashes, all four npm command
statuses zero, and all four probes verified with the exact 19 names. The
command ledger must also have no primary error, signal, or close errors, and
both stream files must be present for every successful command. The
controller must also inspect normal gate exits, source identity/final cleanliness,
candidate SHA and actual GitHub run ID. Missing/incomplete evidence is not a pass.

Root unit tests use a synthetic package, cheap command fixtures, and a tiny
stdio transport, plus immutable legal bytes. They test orchestration, failures,
evidence, and cleanup; they do not execute or certify the real extracted plugin
suite. Full native execution and the final candidate/run receipt are controller
owned. Deterministic benchmarks/offline arithmetic retain those labels; no
model-cost, billing, quality, or savings measurement is inferred.
