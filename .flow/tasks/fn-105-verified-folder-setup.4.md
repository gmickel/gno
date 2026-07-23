---
satisfies: [R1, R3, R4, R5, R6]
---
# fn-105-verified-folder-setup.4 Prove idempotency package behavior and activation documentation

## Description
Deliver prove idempotency package behavior and activation documentation as one implementation-sized increment.

**Size:** M
**Files:** `test/setup`, `scripts/package-smoke.ts`, `docs/QUICKSTART.md`, `docs/INSTALLATION.md`, `docs/TROUBLESHOOTING.md`, `assets/skill/SKILL.md`, `/Users/gordon/work/gno.sh/src/routes/install.tsx`

### Approach
- Run first-run/re-run/interruption/resume/background/connector/security fixtures from source and packed npm install. Extend the existing `bun run test:package` harness without weakening its resident gateway conformance: two-client warm reuse, redacted `resident-status@1.0` at `GET /api/resident/status`, boundary rejection, and restart/shutdown remain covered. <!-- Updated by plan-sync (cross-spec): fn-99-resident-local-context-gateway.5 made resident gateway proof part of the packed-package contract -->
- Replace the happy-path multi-command setup in repo/skill/hosted docs while preserving granular advanced commands.
- Run docs/package/prerelease/skill-autoresearch and hosted deployment verification.

### Investigation targets
**Required** (read before coding):
- `scripts/package-smoke.ts`
- `docs/QUICKSTART.md`
- `docs/INSTALLATION.md`
- `assets/skill/SKILL.md`
- `/Users/gordon/work/gno.sh/src/routes/install.tsx`

**Optional** (reference as needed):
- `docs/WEB-UI.md`
## Acceptance
- [ ] Source and packed-package setup fixtures prove idempotent create/reuse, lexical proof, pending semantic, connector, and resume behavior.
- [ ] Docs/skill/Web/Desktop/gno.sh share one exact setup contract and safe secret-risk behavior.
- [ ] Full prerelease, package smoke, skill eval, gno.sh deploy, service, and revision checks pass.


## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
