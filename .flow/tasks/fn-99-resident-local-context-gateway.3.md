---
satisfies: [R5]
---
# fn-99-resident-local-context-gateway.3 Harden loopback and authenticated non-loopback access

## Description
Deliver harden loopback and authenticated non-loopback access as one implementation-sized increment.

**Size:** M
**Files:** `src/serve/security.ts`, `src/mcp/http-security.ts`, `src/serve/server.ts`, `test/serve/security.test.ts`, `test/mcp/http-security.test.ts`

### Approach
- Set explicit `127.0.0.1`/`::1` defaults because Bun otherwise binds all interfaces.
- Validate Origin and Host with SDK DNS-rebinding protection, reject proxy/header ambiguity, and require a stored/rotatable token before non-loopback binding.
- Apply rate/body/session/queue caps and stable unauthenticated/forbidden/overload responses without logging credentials.

### Investigation targets
**Required** (read before coding):
- `src/serve/security.ts:1-90`
- `src/serve/server.ts:150-210`
- `src/cli/commands/serve.ts`
- `src/app/constants.ts`

**Optional** (reference as needed):
- `test/serve/security.test.ts`
- `src/core/user-dirs.ts`

### Key context
- Loopback does not waive Origin/Host validation; DNS rebinding is a localhost threat.
- Do not trust forwarded headers unless an explicit future proxy mode defines the trust boundary.

## Acceptance
- [ ] Default bind is loopback-only on IPv4/IPv6 and rejects hostile Host/Origin/rebinding fixtures.
- [ ] Non-loopback startup fails without explicit token auth and allowlists.
- [ ] Token rotation/revocation, payload/rate/session limits, and redacted logs pass adversarial tests.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
