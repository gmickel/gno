---
satisfies: [R1, R3, R4, R5, R6]
---
# fn-105-verified-folder-setup.4 Prove idempotency package behavior and activation documentation

## Description
Prove the complete verified-setup contract from source and packed installation, then align all user-facing guidance and hosted activation paths.

**Size:** M
**Files:** `test/setup`, `test/cli/setup.test.ts`, `scripts/package-smoke.ts`, `docs/QUICKSTART.md`, `docs/INSTALLATION.md`, `docs/TROUBLESHOOTING.md`, `assets/skill/SKILL.md`, `/Users/gordon/work/gno.sh/src/routes/install.tsx`

### Approach
- Extend the existing source/package fixtures around the landed `setupFolder` and `FolderSetupReceipt@1.0` contract. Reuse `test/core/folder-setup.test.ts`, `test/core/folder-setup-safety.test.ts`, and `test/core/file-lock.test.ts` as the core truth surface; package work adds CLI/composition coverage rather than restating those internals. <!-- Updated by plan-sync: fn-105.1 landed core setup, safety, interruption, and cross-process convergence coverage in test/core. -->
- Run first-run/re-run/interruption/resume/background/connector/security fixtures from source and packed npm install. Verify the canonical receipt path/permissions/schema, closed six-stage lexical transaction, separate semantic/connector pending or activation projections, and identical typed error/remediation behavior.
- Extend `bun run test:package` without weakening its resident gateway conformance: two-client warm reuse, redacted `resident-status@1.0` at `GET /api/resident/status`, boundary rejection, and restart/shutdown remain covered. <!-- Updated by plan-sync (cross-spec): fn-99-resident-local-context-gateway.5 made resident gateway proof part of the packed-package contract -->
- Replace the happy-path multi-command setup in repo/skill/hosted docs while preserving granular advanced commands. Keep lexical setup success distinct from semantic pending and connector verification; do not document connector/semantic work as fields or stages added to the closed setup receipt.
- Run docs/package/prerelease/skill-autoresearch and hosted deployment verification. Update both `/Users/gordon/work/gno` and `/Users/gordon/work/gno.sh` for behavior-changing documentation.

### Investigation targets
**Required** (read before coding):
- `src/core/folder-setup.ts`
- `src/core/setup-receipt.ts`
- `spec/output-schemas/setup-receipt.schema.json`
- `test/core/folder-setup.test.ts`
- `test/core/folder-setup-safety.test.ts`
- `test/core/file-lock.test.ts`
- `test/cli/setup.test.ts`
- `scripts/package-smoke.ts`
- `docs/QUICKSTART.md`
- `docs/INSTALLATION.md`
- `docs/TROUBLESHOOTING.md`
- `assets/skill/SKILL.md`
- `/Users/gordon/work/gno.sh/src/routes/install.tsx`

**Optional** (reference as needed):
- `docs/WEB-UI.md`

## Acceptance
- [ ] Source and packed-package setup fixtures prove idempotent create/reuse, typed safe failures, canonical receipt persistence, lexical proof, pending semantic, connector composition, interruption/resume, and cross-process convergence behavior.
- [ ] Packed-package checks preserve the closed `FolderSetupReceipt@1.0` schema and stage order, and prove semantic/connector state is composed without mutating or duplicating the lexical receipt.
- [ ] Docs/skill/Web/Desktop/gno.sh share one exact setup contract, safe secret-risk behavior, and honest distinctions among lexical success, semantic pending, and connector verification.
- [ ] Full prerelease, package smoke, skill eval, gno.sh deploy, service, and revision checks pass.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
