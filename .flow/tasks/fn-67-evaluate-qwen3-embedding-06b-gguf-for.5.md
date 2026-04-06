# fn-67-evaluate-qwen3-embedding-06b-gguf-for.5 Add collection-level embedding cleanup actions

## Description

Add a collection-scoped way to remove embeddings either:

- for stale models only
- for all models in that collection

This is the cleanup companion to the model-aware reindex/default-switch work in
task `.3`.

Start here:

- `src/store/sqlite/adapter.ts`
- `src/store/vector/sqlite-vec.ts`
- `src/cli/commands/collection/`
- `src/serve/routes/api.ts`
- `src/serve/public/pages/Collections.tsx`
- `docs/CLI.md`
- `docs/API.md`
- `docs/WEB-UI.md`
- `docs/TROUBLESHOOTING.md`
- `assets/skill/SKILL.md`

Requirements:

- CLI collection-level cleanup action
- Web UI collection-level cleanup action
- API route powering the Web UI
- support two modes:
  - `stale` = remove embeddings for models that are not the currently active
    embed model for that collection
  - `all` = remove all embeddings for that collection
- cleanup must remove both `content_vectors` rows and matching vec-table rows so
  future searches do not see ghost vectors
- stale mode should preserve the active embed model
- all mode should make it obvious that `gno embed --collection <name>` is needed

Recommended CLI shape:

- `gno collection clear-embeddings <name> [--stale|--all]`
- safe default: `--stale`

Recommended Web UI shape:

- collection card menu item:
  - `Embedding cleanup`
- confirmation dialog with:
  - `Clear stale embeddings`
  - `Clear all embeddings`

Tests:

- store-level deletion tests for stale vs all
- CLI tests for the new collection action
- API tests for the cleanup route
- optional DOM smoke for the Collections page flow if cheap

## Acceptance

- [ ] CLI can clear stale or all embeddings for a collection.
- [ ] Web UI can trigger the same cleanup safely.
- [ ] Cleanup removes both stored vectors and vec-table entries for affected models.
- [ ] Stale mode preserves the active embed model for the collection.
- [ ] Docs and skill text explain when to use cleanup vs re-embed.

## Done summary
Added collection-level embedding cleanup actions across CLI, API, and Web UI.

Delivered:
- added store-level collection embedding cleanup with `stale` and `all` modes
- protected vectors shared by active documents in other collections from accidental deletion
- added `gno collection clear-embeddings <name> [--all]`
- added Web UI Embedding cleanup action on collection cards
- added API route for cleanup and docs/skill updates for stale-vs-all usage
## Evidence
- Commits:
- Tests: bun test test/store/adapter.test.ts test/serve/api-collections.test.ts test/cli/collection.test.ts test/cli/smoke.test.ts, bun run lint:check, bun run docs:verify
- PRs: