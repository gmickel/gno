---
satisfies: [R2, R3, R8]
---

## Description

Derive typed edges deterministically during indexing from `relations:` frontmatter and link projection, and consume `contentTypes[].graphHints` as additive projection/diagnostic hints (never standalone edges). Make config edits re-derive. Never mutate user files; no preset-serialization change; no ranking effects.

**Size:** M
**Files:** `src/ingestion/frontmatter.ts`, `src/ingestion/sync.ts`, `src/config/content-types.ts`, `src/core/links.ts` (reference), `test/ingestion/*.test.ts`, `test/config/*.test.ts`, `test/store/*.test.ts`

## Approach

- **Frontmatter `relations:` (nested map):** `src/ingestion/frontmatter.ts:197` `parseFrontmatter` is a hand-rolled line parser (`parseMetadataValue:173`, scalars/flat-arrays only). **Preferred: extend it for one level of nesting** — lower risk than `Bun.YAML` (which changes scalar/date/boolean/tag coercion + never-throw + Logseq fallback). Add regression tests for existing date/category/type/tag/never-throw behavior regardless of approach.
- **Edge derivation runs as a post-upsert projection pass, not inline per-doc:** wire task .1's `backfillDocEdges()` projection to run _after_ all docs in the sync batch are upserted/marked inactive, so `dst` resolution sees the final document set. Task .1 already projects wiki/markdown links → `mentions`/`related_to`; this task extends the projection to parse `relations:` → `frontmatter-relation` edges via `setDocEdges(documentId, edges, "frontmatter-relation")` (replace-by-source, idempotent). Re-derive triggers: doc add/rename/inactivation or content-type-rule fingerprint change.
- **Source of truth for re-projection:** unresolved `relations:` refs are NOT persisted separately — the projection **re-parses each doc's stored frontmatter from its mirror content** on re-derive, so a relation to a not-yet-created target resolves later when that target appears (no ref lost, no new raw-refs table).
- `content_type_source` is already persisted by task .1; preserve that path while adding relation/graphHint re-derivation.
- **graphHints (no standalone edges — they have no target):** for docs whose content type declares graphHints, bias link-projection typing (`confidence: configured`) and surface as traversal/diagnostic hints. **Deterministic multi-hint rule:** treat `graphHints` as an **ordered priority list** — a doc's plain links project to the **single primary (first) hint** only (no fan-out into one edge per hint); remaining hints are diagnostic/traversal hints, not projected edges. Frontmatter `relations:` wins over graphHint projection for the same target. Add normalized `graphHints` to `NormalizedContentTypeRule` (`content-types.ts:22`) and **include them in `fingerprintContentTypeRules`** (`:115` — currently `preset`+`prefixes` only) so edits re-derive.
- **Bump `INGEST_VERSION` 5 → 6** (`sync.ts:73`) so unchanged files reprocess for `relations:` + projected edges.

## Investigation targets

**Required:**

- `src/ingestion/frontmatter.ts:173-197` — line parser to extend
- `src/ingestion/sync.ts:73,293-300,734-781` — `INGEST_VERSION`, `extractDocumentMetadata`, link write site, fingerprint re-derive (`:84-120`)
- `src/config/content-types.ts:22,44,115` — `NormalizedContentTypeRule`, `normalizeContentTypes`, `fingerprintContentTypeRules` (add graphHints)
- `src/config/types.ts:252-277` — `CONTENT_TYPE_GRAPH_HINTS`, `graphHints` schema
- `src/core/links.ts:273` — `parseLinks`/normalization to mirror for projection

## Acceptance

- [x] `relations:` nested-map frontmatter parsed and stored as `frontmatter-relation` edges during indexing
- [x] Frontmatter parsing change preserves existing flat/scalar/tag/never-throw behavior (regression-tested)
- [x] Edge derivation runs as a post-upsert projection pass (sees final doc set); same-sync `relations:` targets resolve; re-derive on add/rename/inactivate/fingerprint-change
- [x] Wiki/markdown link projection from task .1 runs after sync so old `doc_links` read paths and new typed edges stay in parity
- [x] `content_type_source` persistence from task .1 remains covered while relation/graphHint re-derivation is added
- [x] `graphHints` consumed as projection-typing + diagnostic hints (no standalone edges, no-op for ranking); **multi-hint docs project to the single primary hint** (tested)
- [x] `fingerprintContentTypeRules` includes normalized `graphHints`; `INGEST_VERSION` bumped so edits re-derive
- [x] User files never mutated; preset serialization unchanged
- [x] Tests cover relations parsing, graphHints consumption, idempotent re-sync, fingerprint re-derive, ingest-version reprocess

## Done summary

Added sync-time typed-edge derivation: frontmatter relations parsing/projection, post-sync typed-edge projection over the settled active document set, graphHint primary link typing with configured confidence, relation precedence over graphHints, normalized graphHint/relation edge types, graphHint fingerprinting, and ingest version bump to 6.

## Evidence

- Commits:
- Tests: bun run lint && bun run lint:check, bun test test/config/content-types.test.ts test/ingestion/frontmatter.test.ts test/ingestion/sync-links.test.ts test/ingestion/sync-tags.test.ts test/store/links.test.ts, bun test test/store test/spec/schemas test/ingestion test/config
- PRs:
