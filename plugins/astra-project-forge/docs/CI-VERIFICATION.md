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

The root configuration gate is `node --test tests/ci-workflow.test.mjs`.
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
