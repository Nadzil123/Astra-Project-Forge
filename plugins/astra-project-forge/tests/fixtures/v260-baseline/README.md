# Frozen Astra Project Forge v2.6.0 benchmark source

Includes unmodified code from Astra Project Forge.
Original project: https://github.com/Nadzil123/Astra-Project-Forge
Copyright and attribution: see the byte-preserved LICENSE (AGPL-3.0-only),
NOTICE.md and ATTRIBUTION.md beside this file.

Source commit: `267870465ef6c5fe69512c3d217d632f51c6b0af`.
The controller extracted that commit with git archive and verified these four
server modules and all three legal files against the supplied v2.6.0 release
ZIP byte-for-byte. Only the four modules required by the real MCP facade and
their original legal files are frozen here. Do not modernize this source.
The surrounding package's benchmark is new; the baseline modules are unchanged.

SHA256 values:

| File | SHA256 |
| --- | --- |
| server/state-store.mjs | 3f4143ceb52074ae8c40ad044310f7fe3dd2ea3c73d32c6eacb951c11233082c |
| server/agent-state.mjs | 056479e9afe9088ff6c9540252c51af2e87068089756adf7e38cff100b47d33f |
| server/adaptive-router.mjs | 4bc7b5cc669c05121fbeba7e8f58174450c9203d5a044b54998606aeed9bc6c6 |
| server/mcp-server.mjs | e2509f124441ef317dcde139979c139eaa3ee00c15a810d5af69746abae08862 |
| LICENSE | 5132c7f0475b02c8107a2e0f0363e70423c62d2664ab927e76193226e5e05905 |
| NOTICE.md | c35cd5c397efd7eb5313a46f8bce86065f92745d1e080fba134e537e4bcfe598 |
| ATTRIBUTION.md | 74a9857795d90cd3368a73331192f712cc9412d95314eee18ce95486781501a4 |

From an extracted package, run `npm run benchmark:efficiency` and
`node --test tests/v261-benchmark.test.mjs`. Node >=20 is sufficient; no npm
install, git repository, original archive or external service is required.
The benchmark reports its metric definitions and raw comparative measurements.
These are Node/library workloads, not real model runs or billing estimates.
The baseline uses its bounded summary/working context and has no enforced
cycle cap. Both versions stop on independently checked verified completion.
