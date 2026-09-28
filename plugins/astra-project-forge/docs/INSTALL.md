# Install Astra Project Forge 2.6.1 locally

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

The response should identify `astra-project-forge` version `2.6.1`. Version
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
unzip /absolute/path/to/release-artifacts/astra-project-forge-local-2.6.1.zip -d /tmp/forge-standalone
unzip /absolute/path/to/release-artifacts/astra-project-forge-local-marketplace-2.6.1.zip -d /tmp/forge-marketplace
```

The plugin directories are respectively:

- `/tmp/forge-standalone/astra-project-forge-2.6.1`
- `/tmp/forge-marketplace/astra-project-forge-local-marketplace-2.6.1/plugins/astra-project-forge`

In **each** plugin directory run `npm run check`, `npm test`, and
`npm run benchmark:efficiency`. Tests include archive composition, repeatable
rebuilds, and stdio startup from unrelated and special-character paths. They
need no parent manifest or SDD state. From `/tmp`, run the handshake above using
each extracted plugin's absolute server path and confirm version `2.6.1`.
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
gpt-6-astra
```

Override when your Codex build reports another eligible Astra slug:

```bash
export ASTRA_REQUIRED_MODEL="exact-reported-slug"
```

Optionally allow multiple eligible slugs:

```bash
export ASTRA_ALLOWED_MODELS="gpt-6-astra,gpt-6-astra-alt"
```

## State location

Resolution order:

1. `ASTRA_PROJECT_FORGE_DATA_DIR`
2. `PLUGIN_DATA`
3. `~/.astra-project-forge`

## Usage notice

Read the **Usage & Cost Notice** in `README.md` before enabling Standard/Deep workflows. Forge may increase total model/tool usage on complex work.
