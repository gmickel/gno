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
- Run first-run/re-run/interruption/resume/background/connector/security fixtures from source and packed npm install. Validate the closed `setup-command-result@1.0` wrapper and `setup-semantic@1.0` receipt in addition to `FolderSetupReceipt@1.0`; connector proof remains a separately composed shipped activation receipt.
- Prove stable semantic source identity across reruns whose transient setup timestamps, stage tokens, or created/reused disposition differ, while material lexical input/fingerprint/activation changes produce a new identity. Exercise live/dead/concurrent ownership from the installed package.
- Prove `--no-semantic` starts no work and records skipped. When a live one-shot worker already owns the canonical semantic receipt, its PID remains preserved, no duplicate/replacement is spawned, and output distinguishes skipped request intent from live ownership without claiming completion.
- Prove direct packed `gno setup` never discovers, contacts, attaches to, or queues through a resident/MCP/Web process; connector composition in task 3 remains caller-owned and cannot turn resident status into an attachment protocol. Verify the canonical receipt path/permissions/schema, closed six-stage lexical transaction, separate semantic/connector pending or activation projections, and identical typed error/remediation behavior.
- Extend `bun run test:package` without weakening its resident gateway conformance: two-client warm reuse, redacted `resident-status@1.0` at `GET /api/resident/status`, boundary rejection, and restart/shutdown remain covered. <!-- Updated by plan-sync (cross-spec): fn-99-resident-local-context-gateway.5 made resident gateway proof part of the packed-package contract -->
- Replace the happy-path multi-command setup in repo/skill/hosted docs while preserving granular advanced commands. Document the exact landed flags, exit codes, canonical receipt paths, stable semantic source identity, one-shot PID ownership, `--no-semantic` behavior, foreground resume command, and direct-standalone/no-resident-attachment boundary. Keep lexical setup success, semantic receipt state, and task-3 connector activation visibly separate; do not document a connector field in either closed fn-105.2 schema. Keep lexical setup success distinct from semantic pending and connector verification; do not document connector/semantic work as fields or stages added to the closed setup receipt.
- Run docs/package/prerelease/skill-autoresearch and hosted deployment verification. Update both `/Users/gordon/work/gno` and `/Users/gordon/work/gno.sh` for behavior-changing documentation.

### Investigation targets
**Required** (read before coding):
- `src/core/folder-setup.ts`
- `src/core/setup-receipt.ts`
- `spec/output-schemas/setup-receipt.schema.json`
- `test/core/folder-setup.test.ts`
- `test/core/folder-setup-safety.test.ts`
- `test/core/file-lock.test.ts`
- `src/cli/commands/setup.ts`
- `src/cli/commands/setup-semantic.ts`
- `src/cli/setup-semantic-worker.ts`
- `spec/output-schemas/setup-command-result.schema.json`
- `spec/output-schemas/setup-semantic-receipt.schema.json`
- `test/cli/setup.test.ts`
- `test/cli/setup-semantic.test.ts`
- `scripts/package-smoke.ts`
- `docs/QUICKSTART.md`
- `docs/INSTALLATION.md`
- `docs/TROUBLESHOOTING.md`
- `assets/skill/SKILL.md`
- `/Users/gordon/work/gno.sh/src/routes/install.tsx`

**Optional** (reference as needed):
- `docs/WEB-UI.md`

## Acceptance
- [ ] Source and packed-package setup fixtures prove idempotent create/reuse, typed safe failures, canonical lexical/command/semantic receipt persistence, exact lexical proof, semantic worker completion/failure/resume, connector composition, interruption/resume, and cross-process convergence behavior.
- [ ] Packed-package fixtures prove stable semantic source identity ignores transient timestamps/stage tokens/disposition but changes for material source identity, and prove live/dead/concurrent worker ownership is identical to source behavior.
- [ ] `--no-semantic` package coverage proves zero new process creation, truthful skipped state, live PID preservation when an existing worker owns the receipt, no duplicate/replacement, and no false completion claim.
- [ ] Direct source and packed setup remain standalone with no resident discovery/attachment/enqueue behavior; connector verification composes after setup without adding fields to the closed command or semantic schemas.
- [ ] Packed-package checks preserve the closed `FolderSetupReceipt@1.0` schema and stage order, and prove semantic/connector state is composed without mutating or duplicating the lexical receipt.
- [ ] Docs/skill/Web/Desktop/gno.sh share one exact setup contract, safe secret-risk behavior, and honest distinctions among lexical success, semantic pending, and connector verification.
- [ ] Full prerelease, package smoke, skill eval, gno.sh deploy, service, and revision checks pass.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
