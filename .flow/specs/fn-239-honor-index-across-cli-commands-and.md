# Honor --index across CLI commands and clarify mismatch error (#369)

## Problem

`gno links list`, `gno backlinks`, `gno similar`, and `gno publish export` ignore the global `--index` option and open the default index (`index-default.sqlite`). When `--config` points at a config for a second index, the default index holds collections not listed in that config, causing the command to fail with a mismatch error whose hint recommends running `gno cleanup` with that config — which would delete data from the default index. A full sweep of CLI actions also finds `gno collection policy set`, `gno egress-audit <subcommand>`, and `gno init` omitting `globals.index` when opening the store or resolving the database path.

## Acceptance Criteria

- **R1**: Add `indexName?: string` to `LinksListOptions`, `BacklinksOptions`, `SimilarOptions` (`src/cli/commands/links.ts`) and `PublishExportOptions` (`src/cli/commands/publish.ts`), pass `globals.index` from `src/cli/program.ts`, and forward `indexName` to `initStore`.
- **R2**: Sweep all CLI actions in `src/cli/program.ts` and `src/cli/commands/` for store opens or DB path resolution missing `globals.index`; fix all real gaps (`collection policy set`, `egress-audit list|show|status|delete|purge`, `init`) without altering index-agnostic commands.
- **R3**: Update `staleCollectionsMessage` (`src/store/sqlite/adapter.ts`, single source of truth) and all its callers so the mismatch error names the index that was opened, suggests opening a separate index (`--index <name>`, or `dbPath` in the SDK) before mentioning `gno cleanup`, and places the destructive `gno cleanup` hint last while naming the exact index it would affect.
- **R4**: Add CLI-level regression tests in `test/` (isolated with `GNO_CONFIG_DIR`/`GNO_DATA_DIR`/`GNO_CACHE_DIR` under `tmpdir()`, leaving nothing in `TMPDIR`) covering `links list`, `backlinks`, `similar`, `publish export`, `collection policy set`, `egress-audit`, `init`, and the updated mismatch error message (naming both default and non-default indexes); update existing tests quoting the old error message.
- **R5**: Check `spec/cli.md`, `docs/CLI.md`, and `docs/TROUBLESHOOTING.md` for affected commands and error text, updating only what is now wrong (never touching `website/`), and add a `Fixed` entry in `CHANGELOG.md` under `[Unreleased]` referencing `#369`.

## Verification

- `bun run lint:check` passes.
- `bun test` (full suite) passes.
- `bun run test:tmp-check` or TMPDIR cleanliness verified.
- Live CLI reproduction in an isolated sandbox confirms all fixed commands succeed against a non-default `--index` while the default index holds unrelated collections, and captures the new mismatch error text.
- Implementation review via `gpt-6.2-sol` at `medium` effort reaches `SHIP`.
