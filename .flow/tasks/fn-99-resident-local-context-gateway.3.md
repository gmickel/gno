---
satisfies: [R5]
---
# fn-99-resident-local-context-gateway.3 Enforce the network security and authorization contract, then enable /mcp

## Description

Install the complete fail-closed network boundary before enabling HTTP MCP for serve and daemon.

**Size:** M
**Files:** `src/serve/security.ts`, `src/mcp/http-security.ts`, `src/serve/server.ts`, `src/cli/commands/serve.ts`, `src/cli/commands/daemon.ts`, `src/config/schema.ts`, `spec/cli.md`, `spec/mcp.md`, `spec/output-schemas/`, `test/serve/security.test.ts`, `test/mcp/http-security.test.ts`

### Approach

- Run external middleware before body parsing and SDK dispatch on every HTTP method. Read the real peer through Bun `requestIP`; ignore forwarded headers.
- Default to literal `127.0.0.1`. Require explicit non-loopback bind, restrictive token file, exact Host/Origin allowlists, and separate read/write authorization. Authentication never grants mutation by itself.
- Bound declared and chunked bodies, request rates, concurrent requests, queues, and sessions. Return stable redacted `401/403/413/429/503` responses.
- Generate/store tokens with restrictive permissions. Rotation and revocation invalidate already-authenticated sessions. Never log tokens or authorization headers.
- Define config/CLI/spec/schema contracts and only then enable `/mcp` by default for loopback serve/daemon.

### Investigation targets

**Required:** `src/serve/security.ts`, `src/serve/server.ts`, `src/cli/commands/serve.ts`, `src/cli/commands/daemon.ts`, config schema/loader, Bun `requestIP` and body-limit APIs, SDK transport security guidance.

## Acceptance

- [ ] Default bind is loopback-only and hostile peer, Host, Origin, rebinding, forwarded-header, and session-confusion fixtures fail closed.
- [ ] Wildcard/non-loopback startup fails without token file and exact allowlists; token permissions, rotation, revocation, and redaction pass adversarial tests.
- [ ] Declared and chunked oversize bodies, rate/request/queue/session pressure, shutdown admission, and unauthorized writes return the documented stable failures.
- [ ] `/mcp` becomes enabled only after all security fixtures pass; HTTP MCP remains read-only by default.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
