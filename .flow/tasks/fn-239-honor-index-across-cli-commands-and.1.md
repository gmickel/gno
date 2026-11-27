---
satisfies: [R1, R2, R3, R4, R5]
---
# fn-239-honor-index-across-cli-commands-and.1 Implement Honor --index across CLI commands and clarify mismatch error (#369)

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Requirements & Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Threaded global `--index` (`globals.index`) through `links list`, `backlinks`, `similar`, `publish export`, `collection policy set`, all five `egress-audit` subcommands, and `init`. Updated `staleCollectionsMessage` (single source of truth in `src/store/sqlite/adapter.ts`) and its callers so config/index mismatches name the opened index, suggest `--index <name>` (or `dbPath` in the SDK) before `gno cleanup`, and only emit a CLI cleanup command when `getIndexDbPath(selector)` resolves to the opened database (preserving valid Unicode selectors and avoiding misleading commands for custom SDK `dbPath` files outside `GNO_DATA_DIR`). Added isolated CLI/SDK regression tests and updated `spec/cli.md`, `docs/CLI.md`, `docs/TROUBLESHOOTING.md`, and `CHANGELOG.md`.

stage: impl-review - ran [round1-fanout(NEEDS_WORK) -> round2(NEEDS_WORK) -> round3(SHIP)] (model: gpt-6.2-sol)
stage: completion-review - skipped(policy: single-task, per-task SHIP covers spec surface)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: ce3b1405b2cc853a1126d3203bbe11e22e7355ec, 4bda1290188a30220a798573b09bfe01d01659e8, ba97d5fc4743e7b3910f20e877cc85125bdcc691, 2d599af8cd33e51a321a78a1eadb8586d2877045
- Tests: bun run lint:check && bun run test:tmp-check
- PRs: