---
satisfies: [R3, R6]
---
# fn-131-slim-mcp-core-tool-profile-and-mcp-2026.2 MCP 2026-07-28 dual-speak

## Description
2026-07-28 negotiation + sessionless transport + guard parity. **Size:** M. Runs on the POST-MIGRATION SDK (depends on task 4, which owns the v2 migration itself).
Dual-era support: 2025-11-25 clients (initialize-style) keep working byte-for-byte; 2026-07-28 clients negotiate natively (server/discover, sessionless Streamable HTTP). CRITICAL guard parity on the modern sessionless path: authentication, write rejection, egress enforcement, concurrency admission, authorization-epoch invalidation, identity isolation, and transport metrics must flow through the SAME enforcement as the existing HTTP boundary — a raw modern-SDK handler that bypasses these is a security regression, not a feature. Wire-level protocol-version assertions for stdio + HTTP, both eras.

**Touches:** src/mcp transport/handshake modules, sessionless HTTP path, test/mcp/protocol*, spec/mcp.md (protocol section)

## Acceptance
- [ ] SDK migrated; bun install --frozen-lockfile clean; all imports updated; full test suite green
- [ ] 2025-11-25 client golden test unaffected; 2026-07-28 client negotiates natively (wire assertions both transports)
- [ ] Sessionless path proven to enforce auth/write-gate/egress/admission identically to the legacy path (tests per guard)
- [ ] spec/mcp.md documents both negotiated revisions

- [ ] Negative negotiation: unsupported versions rejected with the spec'd error; missing/mismatched MCP-Protocol-Version header handled per spec; a legacy initialize NEVER yields a 2026 negotiation; 2026 `_meta` and `Mcp-Method`/`Mcp-Name` routing headers preserved end-to-end and malformed variants rejected, never silently stripped (tests for each)

## Done summary
Served MCP 2026-07-28 next to 2025-11-25 on both transports, with the sessionless HTTP leg routed through the existing boundary guards.

Design (per the official support-2026-07-28 guide):
- stdio: `gno mcp` now serves through the SDK's connection-pinned `serveStdio` entry (`src/mcp/stdio-serving.ts`, factory builds a fresh surface per instance). A `server/discover` opening negotiates 2026-07-28 natively (supportedVersions, `_meta` serverInfo on every result); a claim-less `initialize` pins 2025-11-25 and is served exactly as before. The legacy parity fixture now spawns the same production entry, so the byte-identical golden (test/mcp/legacy-parity.test.ts, unchanged fixture JSON) covers the shipped path.
- HTTP: `HttpMcpTransport` classifies each POST with the SDK's own `isLegacyRequest` and routes only requests that claim the modern era (envelope key present, or an MCP-Protocol-Version header naming a modern revision) to a strict `createMcpHandler(..., { legacy: "reject" })` leg (`src/mcp/http-modern.ts`, ~130 LOC). Everything else keeps the stateful session path and its established error answers. Capacity, runtime admission, the write gate, per-request egress evaluation, authorization-epoch invalidation, and transport metrics all run before the era branch; the bearer/Host/Origin/body-size boundary still runs in front of the transport for every request. `close()` tears down both legs.
- GNO-owned modern checks (the SDK 2.0.0 leg served both of these; verified in a spike before the guards were written): a modern envelope without `MCP-Protocol-Version` -> 400 `-32020` HeaderMismatch; `Mcp-Session-Id` on a modern request -> 400 `-32600` (a modern request can never bind to or read a 2025 session); non-JSON content type -> 415. Unsupported revisions (`-32022` with `data.supported/requested`), header/body disagreements (`-32020`), malformed envelopes (`-32602`), header-without-envelope (`-32602`), and modern batches (`-32600`) surface the SDK's spec'd errors unchanged. A legacy `initialize` naming `protocolVersion: "2026-07-28"` negotiates down to 2025-11-25 (both transports) and never yields a 2026 negotiation.
- Custom `_meta` keys and the `Mcp-Method`/`Mcp-Name` routing headers are preserved end-to-end (handler sees `ctx.mcpReq._meta` + `envelope`; response carries the serverInfo stamp).

Tests (test/helpers/mcp-wire.ts shared helper):
- test/mcp/protocol-2026.test.ts (18): stdio wire assertions (native 2026 discover + tools/list, modern-pinned connection refuses a later legacy initialize with -32022, legacy initialize pins 2025-11-25 with no serverInfo stamp, unsupported/malformed openings); HTTP with real SDK clients (pin -> modern, auto -> modern, default -> legacy; discover probe carries the standard headers; modern creates no session); legacy initialize naming 2026 negotiates down; a 12-case table of negative negotiation/header/envelope cases; custom `_meta` round-trip.
- test/mcp/sessionless-guards.test.ts (7): one test per guard on the modern leg - bearer authentication (through `HttpMcpSecurity.authorize` with the body-less sanitized request shape the production route hands over), write gate, egress vs actual peer zone, admission (429 at capacity, 503 on shutdown, admitted count returns to 0), authorization-epoch invalidation mid-call (409 EGRESS_POLICY_CHANGED, stale content withheld), identity isolation (cannot borrow another principal's session, never creates one, the victim session survives), transport metrics.
- Existing MCP suites unchanged and green; legacy golden fixtures untouched.

Live verification: `gno mcp --tool-profile core` over real `StdioClientTransport` - pinned 2026 client: era modern / negotiated 2026-07-28 / core 7 tools; auto client: modern; default client: legacy 2025-11-25. `gno daemon --port 3998 --mcp-tool-profile core` (isolated GNO_CONFIG_DIR/DATA_DIR/CACHE_DIR, one scratch collection) over real `StreamableHTTPClientTransport` - pinned 2026 client: era modern / negotiated 2026-07-28 / 7 core tools, wire = `server/discover` + `tools/list` POSTs with `MCP-Protocol-Version: 2026-07-28` + `Mcp-Method`, both 200 with no `Mcp-Session-Id`; default client: era legacy / 2025-11-25 / 7 tools, wire = initialize 200 with a session id, initialized 202, tools/list 200 on that session. The user's own resident runtime on the default index was left running untouched.

Docs: spec/mcp.md new "Protocol Revisions" section (era table, stdio/HTTP routing, rejection table, guard parity) + header + boundary paragraph; docs/MCP.md resident transport paragraph; CHANGELOG [Unreleased] Added; src/mcp/{CLAUDE,AGENTS}.md file tree. Not touched: tool descriptions (task .3), website (~/work/gno.sh; downstream of .3), assets/skill.

Follow-ups (not built): `subscriptions/listen` change streams are served by the SDK entry but not wired to GNO change events (fn-132 territory); `Mcp-Param-*` header mirroring is unused because no GNO tool schema declares `x-mcp-header`.

baseline: green via handoff (verified at a1efaca6 by fn-131-slim-mcp-core-tool-profile-and-mcp-2026.1); lint:check rc=0 pre-edit
gate: gate classify FULL (spec/mcp.md + src touched); bun run lint rc=0; bun test rc=0 (4675 pass / 2 skip / 0 fail, 546 files) at f54e22c3; unittest receipt recorded
stage: impl-review - skipped(config: REVIEW_MODE=none)
## Evidence
- Commits: af2eb1d172d8403152359ca368ee93353f117cc2, f54e22c3993f8fd3067f2fd2c1fa04fa140c8b10
- Tests: bun run lint:check, bun test test/mcp/protocol-2026.test.ts test/mcp/sessionless-guards.test.ts test/mcp/legacy-parity.test.ts test/mcp/http-transport.test.ts test/mcp/http-parity.test.ts, bun test
- PRs:
stage: plan-sync - skipped(config: planSync.enabled != true)
