---
satisfies: [R1, R2, R4, R5]
---
# fn-105-verified-folder-setup.2 Add safe setup CLI UX and semantic background handoff

## Description
Deliver the user-facing `gno setup <folder>` command over the landed core transaction, plus a truthful standalone semantic resume handoff.

**Size:** M
**Files:** `src/cli/program.ts`, `src/cli/commands/setup.ts`, `src/embed/backlog.ts`, `src/core/job-manager.ts`, `spec/cli.md`, `test/cli/setup.test.ts`

### Approach
- Treat `setupFolder(options)` from `src/core/folder-setup.ts` as the only create/reuse, safety-preflight, config/store synchronization, lexical-ingestion, and lexical-proof boundary. Construct its required `store`, `configPath`, `dataDir`, and optional `indexName`; map CLI folder/name/exclusion/secret-authorization inputs to `FolderSetupOptions`; render `FolderSetupResult.error.code`, `message`, and `remediation` without reimplementing planner rules.
- Preserve the closed `FolderSetupReceipt@1.0` contract and its frozen stages (`preflight`, `config_saved`, `store_synced`, `lexical_indexed`, `lexical_proved`, `completed`). Semantic handoff may use its existing generic `pending` projection and the final CLI summary, but must not insert a semantic stage, fork the canonical serializer/path, or invent a second lexical receipt.
- Add `gno setup <folder>` options/terminal/JSON output with progress on stderr and canonical structured output on stdout. Update `spec/cli.md` before wiring the command. The final connector option/behavior belongs to task 3; this task must not execute or claim connector verification.
- Reuse the core secret-risk result. Interactive mode may explicitly authorize and rerun the same transaction; noninteractive/JSON mode fails closed unless the caller supplied the documented exclusion or authorization input. Do not rescan or classify secret files in the CLI.
- A direct `gno setup` invocation stays standalone and must not auto-attach to a resident process. It surfaces an explicit resumable command/status for semantic model/embed work. A resident-owned caller may enqueue through its already-owned job manager. `GET /api/resident/status` (`resident-status@1.0`) remains redacted observability, not an attachment protocol. <!-- Updated by plan-sync (cross-spec): fn-99-resident-local-context-gateway.5 finalized the standalone direct-CLI and resident-status contract -->
- Preserve granular init/collection/index commands and never turn optional semantic work into a prerequisite for the successful lexical receipt.

<!-- Updated by plan-sync: fn-105.1 landed setupFolder(FolderSetupOptions) plus a closed FolderSetupReceipt@1.0; CLI must compose those APIs instead of re-deriving planner or proof logic. -->

### Investigation targets
**Required** (read before coding):
- `src/core/folder-setup.ts`
- `src/core/folder-setup-planning.ts`
- `src/core/setup-receipt.ts`
- `spec/output-schemas/setup-receipt.schema.json`
- `src/cli/program.ts:924-1060`
- `src/cli/commands/init.ts`
- `src/embed/backlog.ts`
- `src/core/job-manager.ts`
- `test/core/folder-setup.test.ts`
- `test/core/folder-setup-safety.test.ts`

**Optional** (reference as needed):
- `src/config/defaults.ts`
- `src/ingestion/walker.ts`

## Acceptance
- [ ] CLI calls `setupFolder` exactly once per attempt, owns no duplicate config/collection/preflight/index/proof logic, and maps the landed typed result into concise terminal remediation and stdout-clean JSON.
- [ ] CLI contract covers name, exclusions/explicit secret authorization, no-semantic, and JSON behavior; connector verification remains deferred to task 3.
- [ ] Successful lexical setup remains immediately usable while semantic work is represented as a truthful pending/resumable handoff without changing the closed six-stage receipt or attaching to a resident process.
- [ ] Secret-risk confirmation, noninteractive failure, empty/unsupported, nested, collision, symlink, huge/network-volume, and interruption outcomes preserve the core error/receipt contract rather than creating CLI-specific decisions.
- [ ] Focused CLI tests prove successful rendering, structured failure, stdout/stderr separation, semantic pending/no-semantic behavior, and exact reuse of the canonical receipt schema.

## Done summary
TBD

## Evidence
- Commits:
- Tests:
- PRs:
