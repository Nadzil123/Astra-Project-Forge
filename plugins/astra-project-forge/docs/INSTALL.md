# Install Astra Project Forge 2.6 locally

Requirements: Node.js 20+ and a Codex build that supports the plugin/hooks configuration used by this package.

The bundled MCP server uses stdio and local JSON state. No external runtime dependency is required.

## Verify the package

```bash
npm test
npm run check
```

## Manual MCP handshake

From the plugin directory:

```bash
printf '%s\n' \
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"manual-test","version":"1"}}}' \
| node ./server/mcp-server.mjs --stdio
```

The response should identify `astra-project-forge` version `2.6.0`.

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
