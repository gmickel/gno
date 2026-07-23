---
satisfies: [R3, R5]
---
# fn-106-browser-clipper-with-provenance.2 Add secure loopback clipper pairing and capture endpoints

## Description
Deliver add secure loopback clipper pairing and capture endpoints as one implementation-sized increment.

**Size:** M
**Files:** `src/serve/clipper-pairing.ts`, `src/serve/routes/clipper.ts`, `src/serve/security.ts`, `src/serve/server.ts`, `src/serve/routes/mcp.ts`, `src/mcp/http-security.ts`, `test/clipper/pairing-security.test.ts`

### Approach
- Create visible user-approved short-lived pairing codes/tokens scoped only to clip preview/write/revoke on loopback resident gateway.
- Validate extension Origin/Host/token, body/rate limits, expiry/revocation/replay, and return existing capture/sync/embed receipt semantics. Compose with the resident gateway's `HttpMcpSecurity` / `createMcpHttpGateway` pre-dispatch boundary where transport policy is shared, but keep the clipper token separately scoped: bearer MCP identity never grants clipper capture and a clipper token never grants general MCP/API writes.
- Use the redacted `resident-status@1.0` response from `GET /api/resident/status` only to report an offline/unavailable resident gateway; never infer a process path, token, caller identity, or an attachment capability from it.
- Keep all non-loopback clip endpoints structurally disabled; pairing cannot authorize general MCP/API writes.

### Investigation targets
**Required** (read before coding):
- `src/serve/server.ts:200-330`
- `src/serve/security.ts:1-90`
- `src/serve/routes/mcp.ts` (`createMcpHttpGateway`)
- `src/mcp/http-security.ts` (`HttpMcpSecurity`)
- `src/serve/routes/api.ts:2869-3020`
- `src/core/capture-write.ts`

**Optional** (reference as needed):
- `src/app/constants.ts`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `src/mcp/http-security.ts`

### Key context
- Clipper token ownership belongs beside the resident gateway auth boundary; do not create a parallel general-purpose identity system. `gateway.enableWrite` / `--mcp-enable-write` controls HTTP MCP mutation only and must not be treated as clipper authorization. <!-- Updated by plan-sync (cross-spec): fn-99-resident-local-context-gateway.5 finalized the production HTTP gateway, write-authorization, and redacted status contracts -->

## Acceptance
- [ ] Visible pairing, scoped write, revoke, expiry, replay, and offline flows return stable receipts/errors.
- [ ] Host/Origin/CSRF/rate/body-limit tests block unauthorized local-web requests.
- [ ] No token grants non-loopback access or unrelated API/MCP write capability.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
