---
satisfies: [R1, R3, R4]
---
# fn-99-resident-local-context-gateway.2 Add isolated Streamable HTTP MCP sessions behind a disabled route

## Description

Implement the Bun/Web Standard MCP transport and session lifecycle, but keep the production route disabled until task 3 installs its full security boundary.

**Size:** M
**Files:** `src/mcp/http-transport.ts`, `src/mcp/http-session.ts`, `src/serve/routes/mcp.ts`, `src/serve/server.ts`, `test/mcp/http-transport.test.ts`, `test/mcp/http-parity.test.ts`

### Approach

- Upgrade the pinned stable MCP SDK to 1.29.x and use `WebStandardStreamableHTTPServerTransport`; do not adopt v2 beta or add Express/Hono.
- Create one `McpServer` and one transport per session. Share only the resident ports and pure surface registration factory.
- Implement POST/GET/DELETE, protocol-version/session-header validation, initialize ownership, idle reap, disconnect/cancellation, bounded admission, and stable malformed/unknown/terminated-session behavior.
- Omit `EventStore`; advertise resumption as unsupported rather than partially emulating it. Configure Bun timeout behavior for SSE.
- Mount the route only behind a test-only/disabled feature gate. No insecure intermediate product surface.

### Investigation targets

**Required:** pinned SDK Web Standard transport implementation/types, MCP 2025-11-25 transport spec, `src/serve/server.ts`, `src/mcp/server.ts`, `src/mcp/resources/index.ts`, and resident runtime from task 1.

## Acceptance

- [ ] Two clients concurrently initialize and call tools with distinct session state over one resident runtime.
- [ ] POST/GET/DELETE, version headers, session IDs, cancellation, disconnect, idle reap, overload, and malformed requests match the pinned SDK/spec.
- [ ] Stdio and HTTP tool/resource contracts and fixture results are equivalent.
- [ ] Route is unreachable in normal serve/daemon startup until task 3 enables it behind security middleware.

## Done summary
Added stable MCP SDK 1.29 Web Standard Streamable HTTP sessions with one isolated server/transport per client, bounded admission, lifecycle cleanup, cancellation, and stdio parity coverage. Kept `/mcp` unreachable in normal serve and daemon startup behind an explicit test-only injection point pending task 3 security.
## Evidence
- Commits: 6bb7eef0d95b383a35078a13dae1212aa7fb00dc
- Tests: GATE_SKIPPED:unittest:green-receipt 81918e6c - baseline reused from prior post-gate pass, GATE_SKIPPED:smoke:green-receipt 81918e6c - baseline reused from prior post-gate pass, GATE_SKIPPED:package:green-receipt 81918e6c - baseline reused from prior post-gate pass, bun test test/mcp/http-transport.test.ts test/mcp/http-parity.test.ts, bun run typecheck, bun install --frozen-lockfile, bun test test/mcp test/serve test/store, bun run smoke:serve-shutdown, bun run test:package, bun run lint:check, .flow/bin/flowctl validate --spec fn-99-resident-local-context-gateway --json
- PRs: #139
