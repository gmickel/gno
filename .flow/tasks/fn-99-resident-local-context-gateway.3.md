---
satisfies: [R5]
---
# fn-99-resident-local-context-gateway.3 Enforce the network security and authorization contract, then enable /mcp

## Description

Install the complete fail-closed network boundary before enabling HTTP MCP for serve and daemon.

**Size:** M
**Files:** `src/serve/security.ts`, `src/mcp/http-security.ts`, `src/mcp/http-transport.ts`, `src/mcp/http-session.ts`, `src/serve/routes/mcp.ts`, `src/serve/server.ts`, `src/cli/commands/serve.ts`, `src/cli/commands/daemon.ts`, `src/config/schema.ts`, `spec/cli.md`, `spec/mcp.md`, `spec/output-schemas/`, `test/serve/security.test.ts`, `test/mcp/http-security.test.ts`, `test/mcp/http-transport.test.ts`

### Approach

- Run external middleware before body parsing and SDK dispatch on every HTTP method. Read the real peer through Bun `requestIP`; ignore forwarded headers.
- Replace task 2's `unsafeTestOnlyMcpRoute` injection seam with the production `/mcp` mount only after the middleware wraps its `HttpMcpTransport` handlers. Preserve its POST/GET/DELETE handling, SSE timeout disabling, admission limits, session lifecycle, and shutdown cleanup.
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

<!-- Updated by plan-sync: fn-99-resident-local-context-gateway.2 used HttpMcpTransport + createTestOnlyMcpRoute, not a production-mounted endpoint -->

## Done summary
Implemented and production-mounted a fail-closed Streamable HTTP MCP gateway for resident serve/daemon runtimes, with loopback defaults, authenticated daemon-only non-loopback access, exact Host/Origin checks, restrictive token lifecycle, read-only authorization, bounded resource admission, and stable redacted failures. Added contract, adversarial, lifecycle, CLI/config, schema, and user documentation coverage; baseline and required gates are green. An extra non-gating docs verifier still reports inherited v1.16.0 references against package v1.17.0 in README/legacy website config, unchanged by this task's feature diff.
## Evidence
- Commits: a15e8b73a5ff0ec2edc8214ecb422b4a8d4b6dea, 26289d8acf8541948d7cdc68e11255d88855d3e2
- Tests: GATE_SKIPPED:unittest:green-receipt 6bb7eef0 - baseline reused from prior post-gate pass, GATE_SKIPPED:smoke:green-receipt 6bb7eef0 - baseline reused from prior post-gate pass, GATE_SKIPPED:package:green-receipt 6bb7eef0 - baseline reused from prior post-gate pass, bun test test/mcp test/serve test/cli/daemon.test.ts test/cli/daemon-flags.test.ts test/cli/serve-flags.test.ts test/cli/smoke.test.ts test/config/loader.test.ts test/spec/schemas (832 pass, 0 fail), bun test test/cli/detach.integration.test.ts (14 pass, 0 fail), bun test test/mcp test/serve test/store (698 pass, 0 fail), bun run smoke:serve-shutdown, bun run test:package, bun run lint:check, .flow/bin/flowctl validate --spec fn-99-resident-local-context-gateway --json
- PRs: