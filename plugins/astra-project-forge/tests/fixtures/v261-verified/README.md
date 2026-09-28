# Frozen verified Astra Project Forge v2.6.1 benchmark source

Includes unmodified code from Astra Project Forge.
Original project: https://github.com/Nadzil123/Astra-Project-Forge
Copyright and attribution: see the byte-preserved LICENSE (AGPL-3.0-only),
NOTICE.md and ATTRIBUTION.md beside this file.

Source commit: `cd0edae9921c80784e11ce3bcaec57f29c224786`.
The eight server modules (including all runtime imports), package.json and
three legal files were extracted from that immutable commit with `git archive`,
not copied from the current working tree. Exact SHA-256 values and extraction
provenance are in `provenance.json`; tests pin them independently. Do not
modernize these files. The package metadata is preserved as historical source;
its development scripts refer to files outside this minimal runtime fixture.

From the enclosing plugin directory, including either release ZIP extraction,
run `npm run benchmark:efficiency` for the three-way report and
`node --test tests/v261-compact-benchmark.test.mjs` for integrity and behavioral
checks. Node >=20 runs the benchmark without git, npm install, or external
services. The archive integration test also uses the existing zip/unzip tools.

`v261_verified` uses this historical runtime and its default full control
responses. `v261_compact` uses current production with summary responses for
route, plan, observe and evaluate. Both execute the same v2.6.1 workload and
control calls. `v260_baseline` retains its separately frozen runtime.
The legacy `v261_efficiency` API still uses current production full controls.

Measurements are serialized MCP dispatch request/response JSON bytes and
variable local timing samples. They are not token, host-cache, compute or
billing measurements. Context bytes are already inside response bytes.
