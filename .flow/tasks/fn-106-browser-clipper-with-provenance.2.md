---
satisfies: [R3, R5]
---
# fn-106-browser-clipper-with-provenance.2 Add secure loopback clipper pairing and capture endpoints

## Description
Deliver add secure loopback clipper pairing and capture endpoints as one implementation-sized increment.

**Size:** M
**Files:** `src/serve/clipper-pairing.ts`, `src/serve/routes/clipper.ts`, `src/serve/security.ts`, `src/serve/server.ts`, `test/clipper/pairing-security.test.ts`

### Approach
- Create visible user-approved short-lived pairing codes/tokens scoped only to clip preview/write/revoke on loopback resident gateway.
- Validate extension Origin/Host/token, body/rate limits, expiry/revocation/replay, and return existing capture/sync/embed receipt semantics.
- Keep all non-loopback clip endpoints structurally disabled; pairing cannot authorize general MCP/API writes.

### Investigation targets
**Required** (read before coding):
- `src/serve/server.ts:200-330`
- `src/serve/security.ts:1-90`
- `src/serve/routes/api.ts:2869-3020`
- `src/core/capture-write.ts`

**Optional** (reference as needed):
- `src/app/constants.ts`

**Planned dependency outputs** (expected by execution; not plan-time investigation sources):
- `src/mcp/http-security.ts`

### Key context
- Clipper token ownership belongs to the resident gateway auth boundary; do not create a parallel general-purpose identity system.

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
