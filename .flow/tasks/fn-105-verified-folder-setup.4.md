---
satisfies: [R1, R3, R4, R5, R6]
---
# fn-105-verified-folder-setup.4 Prove idempotency package behavior and activation documentation

## Description
Prove the complete verified-setup contract from source and packed installation, then align all user-facing guidance and hosted activation paths.

**Size:** M
**Files:** `test/setup`, `test/cli/setup.test.ts`, `test/cli/setup-activation-command.test.ts`, `scripts/package-smoke.ts`, `docs/QUICKSTART.md`, `docs/INSTALLATION.md`, `docs/TROUBLESHOOTING.md`, `assets/skill/SKILL.md`, `/Users/gordon/work/gno.sh/src/routes/install.tsx`

### Approach
- Extend the existing source/package fixtures around the landed `setupFolder` and `FolderSetupReceipt@1.0` contract. Reuse `test/core/folder-setup.test.ts`, `test/core/folder-setup-safety.test.ts`, and `test/core/file-lock.test.ts` as the core truth surface; package work adds CLI/composition coverage rather than restating those internals. <!-- Updated by plan-sync: fn-105.1 landed core setup, safety, interruption, and cross-process convergence coverage in test/core. -->
- Run first-run/re-run/interruption/resume/background/connector/security fixtures from source and packed npm install. Without `--connector`, validate the unchanged `setup-command-result@1.0` wrapper and `setup-semantic@1.0` receipt beside `FolderSetupReceipt@1.0`. With at least one explicit connector, validate the landed `setup-activation-result@1.0` outer object: unchanged nested setup result, bounded per-target state, nullable shipped `ActivationVerificationReceipt@1.0`, and no connector fields added to either closed setup schema. Connector-mode argument or lexical failure must keep the original setup exit code, use outer `status: failed`, emit `connectors: []`, and perform no connector action. <!-- Updated by plan-sync: fn-105.3 landed the closed setup-activation composition. -->
- Exercise the seven landed IDs (`claude-code-skill`, `claude-desktop-mcp`, `cursor-mcp`, `codex-skill`, `opencode-skill`, `openclaw-skill`, `hermes-skill`) through repeatable `--connector` selections. Prove first-seen deduplication, install-once/reuse-without-overwrite, malformed-config preservation, passed MCP smoke receipts, truthful skill `skipped/target_runtime_unverifiable`, bounded remediation/redaction, exact-fingerprint receipt reuse, and recoverable retry. Connector failures/skips remain `completed_with_actions` with exit 0 after lexical proof and never relabel or roll back setup.
- Prove stable semantic source identity across reruns whose transient setup timestamps, stage tokens, or created/reused disposition differ, while material lexical input/fingerprint/activation changes produce a new identity. Exercise live/dead/concurrent ownership from the installed package.
- Prove `--no-semantic` starts no work and records skipped. When a live one-shot worker already owns the canonical semantic receipt, its PID remains preserved, no duplicate/replacement is spawned, and output distinguishes skipped request intent from live ownership without claiming completion.
- Prove direct source and packed `gno setup` never discover, contact, attach to, or queue through a resident/MCP/Web process. Connector composition must open its own post-lexical standalone store, fail boundedly if its factory/open/close lifecycle fails, and cannot turn resident status into an attachment protocol. Verify canonical receipt paths/permissions/schemas, the closed six-stage lexical transaction, separate semantic/connector projections, and identical typed error/remediation behavior.
- Extend `bun run test:package` without weakening its resident gateway conformance: two-client warm reuse, redacted `resident-status@1.0` at `GET /api/resident/status`, boundary rejection, and restart/shutdown remain covered. <!-- Updated by plan-sync (cross-spec): fn-99-resident-local-context-gateway.5 made resident gateway proof part of the packed-package contract -->
- Replace the happy-path multi-command setup in repo/skill/hosted docs while preserving granular advanced commands. Document the exact landed setup flags and seven connector IDs, exit codes, output schema switch, canonical receipt paths, stable semantic source identity, one-shot PID ownership, `--no-semantic`, foreground resume, `completed_with_actions`, skill-runtime limitation, and direct-standalone/no-resident-attachment boundary. Keep lexical setup success, semantic state, and connector activation visibly separate; never document connector/semantic fields or stages inside either closed setup schema.
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
- `src/cli/commands/setup-activation.ts`
- `src/core/setup-activation.ts`
- `src/cli/setup-semantic-worker.ts`
- `spec/output-schemas/setup-command-result.schema.json`
- `spec/output-schemas/setup-semantic-receipt.schema.json`
- `spec/output-schemas/setup-activation-result.schema.json`
- `test/cli/setup.test.ts`
- `test/cli/setup-semantic.test.ts`
- `test/cli/setup-activation-command.test.ts`
- `test/cli/setup-activation-lifecycle.test.ts`
- `test/spec/schemas/setup-activation-result.test.ts`
- `scripts/package-smoke.ts`
- `docs/CLI.md`
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
- [ ] No-connector package output remains `setup-command-result@1.0`; connector mode is exactly `setup-activation-result@1.0` around the unchanged setup result and shipped activation receipts. Invalid/lexically failed connector mode keeps its original nonzero exit, emits an empty connector list, and performs no connector work.
- [ ] Repeatable connector package fixtures cover all seven landed IDs, deterministic dedupe, install-once/reuse-without-overwrite, malformed-config preservation, MCP verification, truthful skill-runtime skip, passed-receipt reuse, recoverable retry, bounded remediation, and absence of config paths/raw child errors/corpus text.
- [ ] Connector failures/skips produce `completed_with_actions` and exit 0 after lexical proof without rolling back lexical success, changing semantic identity/state, or mutating either closed setup schema.
- [ ] Direct source and packed setup remain standalone with no resident discovery/attachment/enqueue behavior; connector composition uses a separate post-lexical standalone store and its factory/open/close failures stay bounded without replacing lexical success.
- [ ] Packed-package checks preserve the closed `FolderSetupReceipt@1.0` schema and six-stage order, and prove semantic/connector state is composed without mutating or duplicating the lexical receipt.
- [ ] Repo docs, skill, Web/Desktop handoff, and gno.sh use the same exact flags, connector IDs, output-schema split, exit semantics, receipt boundaries, safe secret-risk behavior, and honest distinctions among lexical success, semantic pending/skipped/live ownership, connector verification, and `completed_with_actions`.
- [ ] Full prerelease, package smoke, skill eval, gno.sh deploy, service, and revision checks pass.
## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
