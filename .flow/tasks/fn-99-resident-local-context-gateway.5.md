---
satisfies: [R4, R5, R6, R7]
---
# fn-99-resident-local-context-gateway.5 Prove packaged cross-platform gateway behavior and document it

## Description
Deliver prove packaged cross-platform gateway behavior and document it as one implementation-sized increment.

**Size:** M
**Files:** `scripts/package-smoke.ts`, `test/mcp/http-e2e.test.ts`, `docs/MCP.md`, `docs/DAEMON.md`, `docs/ARCHITECTURE.md`, `assets/skill/mcp-reference.md`

### Approach
- Add npm-tarball and desktop-compatible smoke coverage for transport startup, two clients, warm reuse, security, restart, and shutdown on supported systems.
- Keep the known Bun Windows SIGINT/exit-130 failure visible; gateway-specific Windows acceptance belongs here without silently declaring the older foreground smoke fixed.
- Update specs/schemas/docs/skill/gno.sh and run package/prerelease/security gates.

### Investigation targets
**Required** (read before coding):
- `scripts/package-smoke.ts`
- `scripts/serve-shutdown-smoke.ts`
- `.github/workflows/ci.yml`
- `docs/DAEMON.md`
- `docs/MCP.md`

**Optional** (reference as needed):
- `docs/TROUBLESHOOTING.md`
## Acceptance
- [ ] Packaged MCP HTTP transport passes supported OS/architecture smokes or records a specific upstream blocker without suppressing required checks.
- [ ] Docs replace separate-daemon language with the actual resident lifecycle, security, and migration path.
- [ ] Full lint/tests/docs/package/skill evaluation and hosted-doc verification pass.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
