# Install Astra Project Forge 2.6.2 locally

Requirements: Node.js 20+ and a Codex build that supports the plugin/hooks configuration used by this package.

The bundled MCP server uses stdio and local JSON state. No external runtime dependency is required.

## Verify the package

```bash
npm test
npm run check
npm run benchmark:efficiency
```

## Manual MCP handshake

From the plugin directory:

```bash
printf '%s\n' \
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"manual-test","version":"1"}}}' \
| node ./server/mcp-server.mjs --stdio
```

The response should identify `astra-project-forge` version `2.6.2`. Version
metadata is loaded relative to the server module, so an absolute server path
also works from an unrelated current directory such as `/tmp`.

## Build and verify both layouts

Packaging additionally requires installed `zip` and `unzip`; it needs no network
or source checkout. From the plugin, including a standalone extracted copy:

```bash
npm run package:release -- --output-dir /absolute/path/to/release-artifacts
```

The helper prints JSON with each archive's absolute path and plugin-relative
extraction path. It ships its own marketplace manifest with the existing local
identity, `AVAILABLE` installation policy and `ON_INSTALL` authentication policy.

The output directory must be outside the plugin source. The helper resolves
the source and the output's nearest existing ancestor physically, including
symlinks, and retains any not-yet-created output suffix before checking this
boundary. This check does not protect against hostile concurrent filesystem
mutation.

Both ZIPs are built in temporary staging inside the output directory before
either final archive is replaced. A build failure preserves both existing
archives, and staging is cleaned on success or a handled failure. Each final
archive is replaced atomically by rename, but the pair is not a two-file
transaction: failure between the two renames can leave a mixed pair. Rebuild
both archives after a publication failure before using them.

After review and final build, extract the two archives into separate empty
directories:

```bash
unzip /absolute/path/to/release-artifacts/astra-project-forge-local-2.6.2.zip -d /tmp/forge-standalone
unzip /absolute/path/to/release-artifacts/astra-project-forge-local-marketplace-2.6.2.zip -d /tmp/forge-marketplace
```

The plugin directories are respectively:

- `/tmp/forge-standalone/astra-project-forge-2.6.2`
- `/tmp/forge-marketplace/astra-project-forge-local-marketplace-2.6.2/plugins/astra-project-forge`

In **each** plugin directory run `npm run check`, `npm test`, and
`npm run benchmark:efficiency`. Tests include archive composition, repeatable
rebuilds, and stdio startup from unrelated and special-character paths. They
need no parent manifest or SDD state. From `/tmp`, run the handshake above using
each extracted plugin's absolute server path and confirm version `2.6.2`.
Send a `tools/list` request to confirm all nine `forge_*` and ten `adaptive_*`
tools. Use `ASTRA_PROJECT_FORGE_DATA_DIR` pointing to a disposable local
directory for smoke calls that read/write state.

For local marketplace installation, select the extracted versioned marketplace
directory as the marketplace root; its `.agents/plugins/marketplace.json`
resolves `./plugins/astra-project-forge`. The standalone archive carries the
plugin itself. Host plugin installation remains an explicit separate action.

## Model gate

Default expected model slug:

```text
gpt-6.1-sol
```

This default preserves the upstream user decision in commit
`3de4dde661b2ae3b4535c98eb1b26a8fdd0dda55` to require `gpt-6.1-sol`.
It is an eligibility policy, not evidence of universal quality or cost advantages.

Override when your Codex build reports another eligible slug. For Astra-only
eligibility, explicitly set:

```bash
export ASTRA_REQUIRED_MODEL="gpt-6-astra"
```

Eligibility and routing advice are independent operator opt-ins. By default,
only `gpt-6.1-sol` is eligible and routing advice is off. Installing the plugin
or enabling advice does not make Astra eligible. `ASTRA_REQUIRED_MODEL` can also
specify another exact host-reported slug.

To explicitly allow both Astra and Sol, an operator can configure:

```bash
export ASTRA_ALLOWED_MODELS="gpt-6-astra,gpt-6.1-sol"
```

The required slug remains eligible, and additional allowed slugs are trimmed,
lowercased, and deduplicated. Empty or unknown active identities are ineligible.
The hook reads the host-reported top-level model; tool arguments cannot override
operator eligibility. This hook is a host lifecycle guard, not MCP authentication.
Malformed hook JSON produces a neutral protocol response.

Routing advice has a separate opt-in:

```bash
export ASTRA_FORGE_MODEL_ROUTING="advisory-v1"
```

`ASTRA_FORGE_MODEL_ROUTING` accepts only `off` (also the unset default) or
`advisory-v1`; any other value is a configuration error. Advice cannot widen
the allowlist or switch the host model. Configuration is read at process
startup; restart the relevant process after changing settings. The hook uses
eligibility only and does not depend on the advice flag.
Sol-default eligibility does not authorize automatic switching; model selection
remains controlled by the user or host.

These examples do not change installed or global settings. To disable advice,
remove `ASTRA_FORGE_MODEL_ROUTING` or set it to `off`, retaining the original
eligibility settings.

Restart after changing startup configuration and keep the same data directory.
To restore an explicit Astra-only fixture, set `ASTRA_REQUIRED_MODEL=gpt-6-astra`
and remove `ASTRA_ALLOWED_MODELS`; setting the allowlist alone cannot remove the
required/default Sol model. Restore the operator's own saved policy for normal
rollback. No state deletion, downgrade of schemaVersion 2, or receipt rewriting
is needed. Full/recovery/reference and adaptive reads remain reachable on either
explicitly eligible model with all 19 tools.

Clients must check both the initialization experimental capability and optional
`forge_route.modelRouting` schema before using advice; absent/unsupported means
omit the envelope and keep legacy routing. The manual adapter does not switch
models, control host effort or observe trusted identity/usage. `maximum` remains
an internal advisory label, not API effort or host Ultra control.

See the [pilot operator guide](MODEL-ROUTING-PILOT.md) for process-local examples,
manual handoff/resume, useful work beyond budgets and rollback, and the
[offline evaluation contract](MODEL-ROUTING-EVALUATION.md) for actual self-test
and report commands. Empirical comparison is `not_run`; missing metrics remain
`null`. Offline validation/synthetic results do not authorize live model calls,
spending or release. This source pilot is not a new release or installed update.

## State location

Resolution order:

1. `ASTRA_PROJECT_FORGE_DATA_DIR`
2. `PLUGIN_DATA`
3. `~/.astra-project-forge`

## Usage notice

Read the **Usage & Cost Notice** in `README.md` before enabling Standard/Deep workflows. Forge may increase total model/tool usage on complex work.
