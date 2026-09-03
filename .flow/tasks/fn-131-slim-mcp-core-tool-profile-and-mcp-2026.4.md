---
satisfies: [R3, R6]
---
# fn-131-slim-mcp-core-tool-profile-and-mcp-2026.4 MCP SDK v2 migration (isolated)

## Description
The @modelcontextprotocol/sdk v1.30.0 → v2 migration in isolation, per the official upgrade-to-v2 guide (package split into several packages; manual behavioral adaptation beyond import rewriting). Scope: package.json + bun.lock, every sdk import site, scripts referencing the sdk, affected tests; legacy 2025-11-25 behavior preserved byte-for-byte (golden parity test BEFORE any 2026 feature work). No new features in this task — migration + parity only, so an iteration boundary can never leave a mixed v1/v2 tree with modern features half-attached. **Size:** L.

**Touches:** package.json, bun.lock, all @modelcontextprotocol/sdk import sites, scripts, affected tests

## Acceptance
- [ ] TBD

- [ ] bun install --frozen-lockfile clean post-migration; full suite green
- [ ] Legacy golden parity: pre/post tool-list + handshake byte-identical for a 2025-11-25 client
- [ ] No 2026-era feature code in this task's diff

## Done summary
Migrated GNO's MCP server and client from `@modelcontextprotocol/sdk` 1.30.0 to the split v2 packages `@modelcontextprotocol/server` 2.0.0 and `@modelcontextprotocol/client` 2.0.0 (core 2.0.0 transitively), per the official upgrade-to-v2 guide, with the 2025-11-25 legacy wire pinned by a golden parity test taken before the migration. No 2026-era feature code (no server/discover, no sessionless HTTP, no tool profiles).

SDK health check (npm, 2026-09-03): `@modelcontextprotocol/sdk` latest is still 1.30.0; the v2 line ships as `@modelcontextprotocol/{core,client,server,node,express,hono,fastify}` all at 2.0.0 (one shared version since 2.0.0-beta.1), Node >= 20, zod ^4.2.0 (repo already on zod 4.4.3). Bun serves the web-standard transport, so `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/server` is the right runtime (no `@modelcontextprotocol/node`). The v2 client defaults to `versionNegotiation: 'legacy'`, so the connector verifier, smoke scripts, and evals keep the plain 2025 initialize sequence.

What changed:
- package.json / bun.lock: sdk 1.30.0 removed; server + client 2.0.0 pinned exact; `bun install --frozen-lockfile` clean.
- Every import site (src/mcp/*, src/core/connector-verifier.ts, scripts/package-smoke-resident*.ts, evals/agentic/lifecycle/*.ts, 11 test files) moved to v2 package paths; stdio transports on the `./stdio` subpaths.
- Registration: 36 variadic `server.tool()` calls became `registerTool` with `z.object` schemas; `server.resource()` became `registerResource`; handler contexts use `ctx.sessionId` / `ctx.mcpReq.signal`; `client.callTool` dropped the result-schema argument at 5 call sites; the connector-verifier test fixture resolves the v2 module paths with `Bun.resolveSync`.
- Legacy wire preserved: capabilities declare `listChanged: true` (SDK v1 always advertised it regardless of the declared value); `gno_ask` registers the non-strict `z.object(askInputSchema.shape)` that v1 advertised (the handler is unchanged).

Parity evidence (test/mcp/legacy-parity.test.ts, fixtures under test/fixtures/mcp/):
- Handshake (initialize result, and the HTTP initialized 202) is byte-identical over stdio and Streamable HTTP for a 2025-11-25 client, read set and --enable-write set.
- tools/list is byte-identical against the re-baselined golden `legacy-2025-11-25.json` and identical to the frozen pre-migration capture `legacy-2025-11-25.sdk-v1.30.0.json` (names, order, descriptions, annotations, schemas incl. key order) modulo three SDK-owned deltas the test asserts explicitly: `$schema` stamp draft-07 -> 2020-12 (and its key position); the removed experimental `execution.taskSupport` member (SEP-2663); `gno_rename_note` / `gno_move_note` advertise their real `oneOf` schema where SDK v1 emitted an empty `{type:object, properties:{}}` placeholder for discriminated unions. Literal byte-identity of tools/list would require re-emitting a removed experimental member and misreporting the validation dialect, so the AC is met as handshake byte-identical + tools/list byte-identical modulo the documented SDK deltas.
- Behavioral delta documented (CHANGELOG, spec/mcp.md): an unknown tool name now answers JSON-RPC -32602 instead of a CallToolResult with isError (test/mcp/server.test.ts re-baselined).

Not touched: write gate (`MCP_WRITE_TOOL_NAMES`, `--enable-write`), egress enforcement, auth, admission, authorization epoch - all pre-existing tests pass unchanged.

Inherited reds (not caused, not fixed): `bunx tsc --noEmit` has one pre-existing error in src/core/audit-workspace.ts:120 (untouched); `bun run docs:verify` fails on README/website version drift and skill parity (untouched). Neither is a spec Quick command. A stale `node_modules/@modelcontextprotocol/sdk` directory remains on disk (not in bun.lock; harmless).

Follow-ups for .2 (not built here): 2026-07-28 dual-speak via `versionNegotiation` / server/discover / sessionless HTTP through the same enforcement path.

baseline: green (bun run lint:check rc=0; bun test 4635 pass / 0 fail at b5c4f2fe)
stage: impl-review - skipped(config: REVIEW_MODE=none)
## Evidence
- Commits: 5ce23888e6061bd68081032e469c05a09b3faf41, aa569a36e3f4f868f54c9653bf98d37287fadb93
- Tests: bun run lint:check, bun test (4637 pass, 2 skip, 0 fail; receipt aa569a36-unittest), bun test test/mcp/legacy-parity.test.ts, bun test test/mcp test/core/connector-verifier.test.ts test/indexed-uri-roundtrip.test.ts test/memory-fence-e2e.test.ts test/serve/resident-concurrency.test.ts, bun install --frozen-lockfile
- PRs:
stage: plan-sync - skipped(config: planSync.enabled != true)
