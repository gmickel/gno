---
satisfies: [R2, R3, R8]
---

## Description

Derive typed edges deterministically during indexing from `relations:` frontmatter and link projection, and consume `contentTypes[].graphHints` as additive projection/diagnostic hints (never standalone edges). Make config edits re-derive. Never mutate user files; no preset-serialization change; no ranking effects.

**Size:** M
**Files:** `src/ingestion/frontmatter.ts`, `src/ingestion/sync.ts`, `src/config/content-types.ts`, `src/core/links.ts` (reference), `test/ingestion/*.test.ts`, `test/config/*.test.ts`, `test/store/*.test.ts`

## Approach

- **Frontmatter `relations:` (nested map):** `src/ingestion/frontmatter.ts:197` `parseFrontmatter` is a hand-rolled line parser (`parseMetadataValue:173`, scalars/flat-arrays only). **Preferred: extend it for one level of nesting** — lower risk than `Bun.YAML` (which changes scalar/date/boolean/tag coercion + never-throw + Logseq fallback). Add regression tests for existing date/category/type/tag/never-throw behavior regardless of approach.
- **Edge derivation runs as a post-upsert projection pass, not inline per-doc:** wire task .1's `backfillDocEdges()` projection to run _after_ all docs in the sync batch are upserted/marked inactive, so `dst` resolution sees the final document set (a `relations:` target created in the same sync resolves). Parse `relations:` → `frontmatter-relation` edges and project wiki/markdown links → `mentions`/`related_to` via `setDocEdges(documentId, edges, source)` (replace-by-source, idempotent). Re-derive triggers: doc add/rename/inactivation or content-type-rule fingerprint change.
- **Source of truth for re-projection:** unresolved `relations:` refs are NOT persisted separately — the projection **re-parses each doc's stored frontmatter from its mirror content** on re-derive, so a relation to a not-yet-created target resolves later when that target appears (no ref lost, no new raw-refs table).
- **Populate `content_type_source`** into its new `documents` column (task .1) during `extractDocumentMetadata` (`sync.ts:293`) — currently it's only in the sync result.
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

- [ ] `relations:` nested-map frontmatter parsed and stored as `frontmatter-relation` edges during indexing
- [ ] Frontmatter parsing change preserves existing flat/scalar/tag/never-throw behavior (regression-tested)
- [ ] Edge derivation runs as a post-upsert projection pass (sees final doc set); same-sync `relations:` targets resolve; re-derive on add/rename/inactivate/fingerprint-change
- [ ] Wiki/markdown links projected to semantic edges idempotently (replace-by-source) on sync
- [ ] `content_type_source` populated into its `documents` column during ingestion
- [ ] `graphHints` consumed as projection-typing + diagnostic hints (no standalone edges, no-op for ranking); **multi-hint docs project to the single primary hint** (tested)
- [ ] `fingerprintContentTypeRules` includes normalized `graphHints`; `INGEST_VERSION` bumped so edits re-derive
- [ ] User files never mutated; preset serialization unchanged
- [ ] Tests cover relations parsing, graphHints consumption, idempotent re-sync, fingerprint re-derive, ingest-version reprocess

## Done summary

_Filled in on completion._

## Evidence

_Links to commits, tests, and verification._
