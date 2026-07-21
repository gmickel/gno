---
satisfies: [R1, R3, R4]
---
# fn-99-resident-local-context-gateway.2 Add stateful Streamable HTTP MCP transport

## Description
Deliver add stateful streamable http mcp transport as one implementation-sized increment.

**Size:** M
**Files:** `src/mcp/http-transport.ts`, `src/serve/server.ts`, `src/serve/routes/mcp.ts`, `test/mcp/http-transport.test.ts`

### Approach
- Mount SDK WebStandardStreamableHTTPServerTransport at `/mcp` with UUID session IDs and explicit POST/GET lifecycle semantics.
- Bind each session to authenticated caller state, propagate cancellation/disconnect, and reap idle sessions/streams with bounded queues.
- Preserve contract-equivalent tool/resource behavior and report unsupported resumption explicitly rather than partially emulating it.

### Investigation targets
**Required** (read before coding):
- `src/serve/server.ts:150-330`
- `src/mcp/server.ts`
- `src/mcp/resources/index.ts`
- `node_modules/@modelcontextprotocol/sdk`

**Optional** (reference as needed):
- `test/mcp/server.test.ts`
- `src/serve/jobs.ts`

### Key context
- SSE requests need Bun request timeout disabled or adjusted; request/body/session limits and overload codes are contract surface.
- Honor `Mcp-Session-Id` on every post-initialize request.

## Acceptance
- [ ] Two independent clients concurrently initialize and call tools through one resident runtime.
- [ ] Session IDs, reconnect/disconnect/cancellation/idle reap, overload, and malformed-request fixtures follow the pinned MCP spec/SDK.
- [ ] HTTP and stdio response contracts match on shared fixtures.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
