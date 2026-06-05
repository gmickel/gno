---
satisfies: [R4, R5, R7]
---

## Description

Make frontmatter `type` the canonical `contentType` — gated on a configured `contentTypes[].id` — via the documented priority chain, additively (existing notes stay valid). Plumb the normalized content-type rules through `SyncOptions` and **every sync entrypoint**, and define a config-change backfill that survives later user edits (not just a one-time version bump). Expose per-result `contentType` consistently in search/query JSON output + schemas. Reads `.2`'s `NormalizedContentTypeRule[]` rules from normalized `config.contentTypes` (`loadConfig()` / `normalizeConfigContentTypes()`) and preset IDs from `.1`. <!-- Updated by plan-sync: fn-83-second-brain-page-types-and-synthesis.2 used normalized config.contentTypes + NormalizedContentTypeRule, not a separate loader rules field -->

**Size:** M
**Files:** `src/ingestion/types.ts` (`SyncOptions` field), `src/ingestion/sync.ts` (inference + `INGEST_VERSION`/fingerprint), sync entrypoints (`src/mcp/tools/{sync,index-cmd}.ts`, `src/cli/commands/shared.ts`, `src/sdk/client.ts`, `src/serve/{background-runtime,watch-service}.ts`, `src/serve/routes/api.ts`), `src/store/types.ts` (`FtsResult` — required), `src/pipeline/types.ts` (`SearchResult` — required), SQLite `SELECT` in the store adapter, search pipeline (`src/pipeline/{search,hybrid,vsearch,fusion}.ts`), MCP/CLI JSON formatters, `spec/output-schemas/search-results.schema.json` + `search-result.schema.json`, fixtures, plus the fingerprint persistence surface (store metadata/migration) if the fingerprint path is chosen, `test/ingestion/<...>.test.ts`, `test/spec/schemas/<...>.test.ts`, `docs/HOW-SEARCH-WORKS.md`.

## Approach

- **Plumb config into ingestion:** add a `contentTypeRules: NormalizedContentTypeRule[]` field to `SyncOptions` (`src/ingestion/types.ts:118`); thread it into `extractDocumentMetadata` (`sync.ts:246`, call site `:565`). Make **every sync entrypoint** pass normalized rules from `.2`: file-loaded configs get normalized `config.contentTypes` via `loadConfig()` / `normalizeConfigContentTypes()`, while entrypoints that cannot prove normalization should call `normalizeContentTypes(config.contentTypes ?? []).rules` or explicitly default to `[]` (MCP sync/index, CLI shared, SDK client, serve background-runtime/watch-service/api). No entrypoint receives raw, un-normalized `contentTypes`. <!-- Updated by plan-sync: fn-83-second-brain-page-types-and-synthesis.2 exported normalizeConfigContentTypes and NormalizedContentTypeRule -->
- In `extractDocumentMetadata` (hook `:253-258`) implement priority (Decision 6): (1) frontmatter `type` → canonical `contentType` **iff `type` matches a configured `contentTypes[].id`**; (2) configured prefix match (longest-prefix-wins, from `.2`); (3) frontmatter `category`/`categories` as **filters only**; (4) existing path/ext `inferContentType` (`:213-228`); (5) fallback `prose`/`note`. Unconfigured/free-text `type` keeps today's category-only behavior — no regression.
- **Observability (named surface):** `extractDocumentMetadata` returns a `contentTypeSource` discriminator (`'frontmatter-type' | 'prefix' | 'path-ext' | 'fallback'`) alongside `contentType`; surface it in sync verbose/debug output and assert it in unit tests (concrete + testable — not just "debug/explain").
- **Backfill (fingerprint, not just version bump):** unchanged files skip reprocessing when `ingestVersion >= INGEST_VERSION` (`sync.ts:70`, `5`). A one-time `INGEST_VERSION` bump only backfills the first upgrade; later `contentTypes` edits won't re-derive unchanged docs. Pick ONE and implement it fully: (a) **config fingerprint** — persist a hash of the normalized rules (store metadata/migration) and force-reprocess docs whose stored fingerprint differs; or (b) **explicit force-resync** — a named CLI flag / API param (e.g. `--resync`) that callers invoke after a config edit. Whichever is chosen, name the persistence/trigger surface and test that a prefix/preset change actually reprocesses affected unchanged docs.
- **Search exposure (coordinated):** select `contentType` in the BM25 SQLite query; add it to `FtsResult` (`src/store/types.ts:330`) and `SearchResult` (`src/pipeline/types.ts:41`); carry it through BM25/vector/hybrid/fusion builders; add the property to `search-results.schema.json` + `search-result.schema.json` and update fixtures; surface it in the JSON formatters. Scope: JSON + schema surfaces; plain-text `md/xml/csv` formatters unchanged. Add a contract test in `test/spec/schemas/`.
- Confirm `--category <type>` matches typed pages (store filter already checks `content_type IN (...) OR categories json_each(...)`).
- **File-overlap note:** fn-60 also edits `sync.ts` — own only the `contentType`/`type` field logic here.
- Update `docs/HOW-SEARCH-WORKS.md` with the inference order + backfill note in the same commit.

## Investigation targets

**Required:**

- `src/ingestion/types.ts:118` (SyncOptions), `src/ingestion/sync.ts:70,213-228,246-261,426,565`.
- `src/store/types.ts:110,330` — contentType, `FtsResult`. `src/pipeline/types.ts:41` — `SearchResult`.
- `src/pipeline/{search,hybrid,vsearch,fusion}.ts` — result builders carrying contentType.
- `spec/output-schemas/search-results.schema.json`, `search-result.schema.json`; `test/spec/schemas/`.
- `src/config/content-types.ts` `NormalizedContentTypeRule`, `normalizeContentTypes()`, `normalizeConfigContentTypes()`; `src/config/types.ts` `contentTypes` schema (from `.2`).

**Optional:**

- `src/store/sqlite/adapter.ts` (category filter SQL + BM25 SELECT).
- Sync entrypoints listed in Files — confirm each forwards or defaults the rules.

## Acceptance

- [ ] R5: frontmatter `type` drives canonical `contentType` **iff it matches a configured `contentTypes[].id`**; unconfigured/free-text `type` keeps legacy category-only behavior; existing notes remain valid.
- [ ] R5: tests distinguish `contentType` from category filters (configured `type: person` resolves contentType `person`; unconfigured `type: foo` does not change contentType).
- [ ] R4: `contentTypeRules: NormalizedContentTypeRule[]` (from `.2`'s normalized `config.contentTypes`, `normalizeConfigContentTypes()`, or `normalizeContentTypes().rules`) plumbed through `SyncOptions` and every sync entrypoint (or explicit `[]` default — none receive raw config); a **config-fingerprint OR named force-resync** backfill is implemented with its persistence/trigger surface named and tested (a prefix/preset change reprocesses affected unchanged docs; INGEST_VERSION bump alone insufficient); `gno ls/search/query --category <type>` matches typed pages.
- [ ] R4: `extractDocumentMetadata` returns a `contentTypeSource` discriminator surfaced in sync verbose/debug and asserted in tests.
- [ ] R7: search/query results expose `contentType` + `categories` per item across BM25/vector/hybrid (`FtsResult` in `src/store/types.ts`, `SearchResult` in `src/pipeline/types.ts`); `search-results.schema.json` (+ single) + fixtures updated; contract test added/passing; plain-text formatters unchanged.
- [ ] `docs/HOW-SEARCH-WORKS.md` updated; `bun run lint:check && bun test` green.

## Done summary

Implemented configured content type inference during sync: canonical frontmatter type matches, prefix fallback, preserved path heuristics, and config-fingerprint based reprocessing. Search result JSON/schema surfaces now include contentType and categories across BM25/vector/hybrid paths, with docs and regression tests updated.

## Evidence

- Commits: c1f3cd7d2273e56a79137add85d20a9aa8825e56, 37bbdc6c05fef19229b53c94abdd77f7030c89c9
- Tests: bun run lint:check && bun test, bun test test/config/content-types.test.ts test/ingestion/sync-tags.test.ts test/store/fts.test.ts test/cli/search-smoke.test.ts
- PRs:
