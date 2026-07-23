---
satisfies: [R4, R5, R6, R7]
---
# fn-99-resident-local-context-gateway.5 Prove packaged cross-platform behavior and ship docs

## Description

Validate the installed product boundary and publish the complete lifecycle/security contract.

**Size:** M
**Files:** `scripts/package-smoke.ts`, `scripts/package-smoke-mcp.ts`, `scripts/serve-shutdown-smoke.ts`, `src/mcp/http-security.ts`, `src/serve/routes/mcp.ts`, `src/serve/resident-status.ts`, `src/cli/detach.ts`, `test/mcp/http-security.test.ts`, `test/mcp/http-transport.test.ts`, `test/mcp/http-parity.test.ts`, `test/serve/resident-health.test.ts`, `test/cli/detach.test.ts`, `.github/workflows/ci.yml`, `spec/cli.md`, `spec/mcp.md`, `spec/output-schemas/mcp-http-error.schema.json`, `spec/output-schemas/resident-status.schema.json`, `spec/output-schemas/process-status.schema.json`, `spec/output-schemas/status.schema.json`, `docs/CLI.md`, `docs/CONFIGURATION.md`, `docs/MCP.md`, `docs/DAEMON.md`, `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/TROUBLESHOOTING.md`, `assets/skill/SKILL.md`, `assets/skill/mcp-reference.md`, `README.md`, `/Users/gordon/work/gno.sh`

### Approach

- Run packed npm tarball smokes for the production-secured `/mcp` gateway: loopback startup, two clients, contract parity, warm reuse, `GET /api/resident/status` and `GET /api/status` lifecycle projections, token/Origin/Host rejection, restart, and shutdown. Validate the redacted `resident-status@1.0` snapshot and the best-effort `process-status@1.0.resident` snapshot from detached `serve` and `daemon` status; do not require the latter when its listener is unavailable.
- Extend the existing `scripts/package-smoke.ts` and `scripts/package-smoke-mcp.ts` harnesses with task 3's `HttpMcpSecurity` boundary and production `createMcpHttpGateway` route coverage, using `test/mcp/http-security.test.ts`, `test/mcp/http-transport.test.ts`, and `test/mcp/http-parity.test.ts` as the baseline.
- Prove the external boundary from a packed install: `gno serve` remains loopback-only; only `gno daemon` may use an explicit non-loopback bind with a restrictive token file and exact Host/Origin allowlists; authentication alone never enables writes.
- Add desktop-compatible endpoint proof without coupling per-feature progress to macOS/Windows artifact completion; record those jobs for the consolidated final sweep.
- Update CLI/MCP/API schemas and user docs, skill assets, examples, migration guidance, troubleshooting, and hosted gno.sh product/docs surfaces.
- Run prerelease, package, docs, security, skill autoresearch, and hosted-site gates. Keep any existing unrelated Windows SIGINT/exit-130 limitation visible rather than suppressing it.

### Investigation targets

**Required:** package smoke scripts, CI/publish workflows, packaging docs, MCP/daemon/API docs, skill source of truth, hosted gno.sh docs/product pages.

## Acceptance

- [ ] Packed npm gateway smokes pass the two-client, warm-reuse, security, restart, health, and shutdown contract, including schema-valid, redacted `resident-status@1.0` API and detached-process projections, daemon non-loopback rejection/authorization, and serve loopback-only enforcement.
- [ ] Supported OS/architecture coverage passes or records a precise upstream blocker without weakening required checks; client artifact builds remain nonblocking until the final roadmap sweep.
- [ ] README, specs/schemas, docs, skill, examples, migration/troubleshooting, and gno.sh are current and independently verified.
- [ ] Full prerelease, package, security, Flow validation, and hosted production smoke evidence is attached.

<!-- Updated by plan-sync: fn-99-resident-local-context-gateway.2 used the existing package-smoke-mcp and HTTP transport/parity harnesses, not test/mcp/http-e2e.test.ts -->
<!-- Updated by plan-sync: fn-99-resident-local-context-gateway.3 used HttpMcpSecurity + createMcpHttpGateway as the production boundary; daemon alone supports authenticated non-loopback MCP -->
<!-- Updated by plan-sync: fn-99-resident-local-context-gateway.4 used resident-status@1.0 at GET /api/resident/status and best-effort process-status@1.0.resident snapshots -->

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
