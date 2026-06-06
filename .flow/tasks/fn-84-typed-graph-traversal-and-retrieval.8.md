---
satisfies: [R5, R7, R8]
---

## Description

Add optional `--edge-type`/`--relation` filters to the existing `gno links` / `gno backlinks` commands, querying the **semantic edge layer** (`doc_edges`). Keep command shape; semantic edges may lack positional info, so schemas allow nullable position. Split from task .3 per review (shared CLI wiring → serialized after .3).

**Size:** S/M
**Files:** `src/cli/commands/links.ts`, `src/cli/program.ts`, `src/cli/options.ts`, `spec/cli.md`, `spec/output-schemas/links-list.schema.json` (extend), `spec/output-schemas/backlinks.schema.json` (extend — already exists), `docs/CLI.md`, `test/cli/*.test.ts`, `test/spec/schemas/*.test.ts`

## Approach

- Add `--edge-type`/`--relation` to `linksList` (`links.ts:314`, existing `--type` syntax filter at `:348`) and `backlinks` (`links.ts:430`). When set, query the typed-edge read API from task .1 instead of positional `doc_links`. **Keep command shape** (`gno links <doc>` already default; do NOT add `gno links list`).
- **`--type` and `--edge-type`/`--relation` are mutually exclusive:** `--type` filters positional `doc_links` (syntax: `wiki|markdown`); `--edge-type`/`--relation` switches to the semantic `doc_edges` layer. Combining them is a **validation error (exit 1)** — not a silent precedence.
- Without `--edge-type`/`--relation`, behavior + output are **unchanged** (positional links, backward compatible).
- Semantic edges may have no line/col/link-text. The existing `links-list.schema.json` **requires** `targetRef`/`linkType`/`startLine`/`startCol` on each item, so use a **`oneOf` item shape**: (a) the existing **positional link item** (unchanged required fields) OR (b) a **semantic edge item** requiring `edgeType`/`confidence`/`edgeSource` (`wikilink|markdown-link|frontmatter-relation`) + target/source docid/uri, with no positional fields. **Do NOT overload the existing positional `source` enum** (`parsed|user|suggested`) — `edgeSource` is a new distinct field. Apply the same `oneOf` to `backlinks.schema.json`. **Register both (already-present) schemas remain in `test/spec/schemas/validator.ts`** `schemaFiles` (no new entry needed, but confirm the `oneOf` validates). `schemaVersion` stays **optional/additive** (required only on new schemas) so existing outputs + contract tests don't break.
- Filters degrade cleanly to empty when no typed data exists.
- Register any new flags/format entries in `src/cli/options.ts` `CMD`. Shared files (`program.ts`/`options.ts`/`spec/cli.md`/`docs/CLI.md` links sections) — this task runs after .3 to avoid conflicts.

## Investigation targets

**Required:**

- `src/cli/commands/links.ts:20,67,314,348,430` — options + `linksList`/`backlinks` + existing `--type` filter
- `src/cli/program.ts:2146` — `wireLinksCommands`; `src/cli/options.ts:21` — `CMD` registry
- `spec/output-schemas/links-list.schema.json`, `spec/output-schemas/backlinks.schema.json` — extend (nullable position, optional schemaVersion)
- task .1 typed-edge read API — the semantic-layer reader to call

## Acceptance

- [ ] `gno links`/`gno backlinks` accept optional `--edge-type`/`--relation`, querying the semantic edge layer
- [ ] `--type` + `--edge-type`/`--relation` together → validation error (exit 1), tested
- [ ] Existing command shape + default (positional) output unchanged and backward-compatible
- [ ] `links-list.schema.json` + `backlinks.schema.json` use a `oneOf` (positional link item OR semantic edge item with `edgeType`/`confidence`/`edgeSource` + target/source ref, no positional fields); `source` enum NOT overloaded; `schemaVersion` optional/additive (existing contract tests still pass)
- [ ] Filters degrade cleanly with no typed data
- [ ] `spec/cli.md` + `docs/CLI.md` links/backlinks sections updated
- [ ] Tests cover edge-type filtering, no-typed-data degradation, and backward-compatible default output

## Done summary
Implemented semantic edge filters for links/backlinks.

- Added `--edge-type` and `--relation` to `gno links` / `gno backlinks`; semantic mode uses `doc_edges` via shared store APIs.
- Preserved default positional output and `--type` behavior; rejects `--type` mixed with semantic filters.
- Treats `--relation` as an alias for `--edge-type`; conflicting alias values are validation errors.
- Extended links/backlinks output schemas with strict `oneOf` positional vs semantic item shapes, including `edgeType`, `relationType`, `confidence`, and `edgeSource`.
- Updated CLI spec/docs and added CLI/schema regressions for semantic filters, empty typed results, mixed filters, conflicting aliases, and mixed schema rows.
- RepoPrompt implementation review returned SHIP after one fix loop.
## Evidence
- Commits:
- Tests: bun run lint, bun run lint:check, bun test test/cli/commands/links.test.ts test/spec/schemas/api-links.test.ts (63 pass), bun test test/cli/commands/links.test.ts test/spec/schemas/api-links.test.ts test/store/links.test.ts test/ingestion/sync-links.test.ts test/core/graph-query.test.ts (129 pass)
- PRs: