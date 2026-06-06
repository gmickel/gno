---
satisfies: [R1, R8]
---

## Description

Add the typed-edge data model: a derived `doc_edges` table with **distinct** new types, replace-by-source write semantics, and a backfill that reuses the resolver **extracted in task .9** so it matches `getGraph`. Foundation + early proof point — must prove backward compatibility and backfill parity before any surface is built on top. Depends on `.9` (the behavior-preserving resolver + ref-parser extractions).

**Size:** M
**Files:** `spec/db/schema.sql`, `src/store/migrations/010-typed-edges.ts`, `src/store/migrations/index.ts`, `src/store/types.ts`, `src/store/sqlite/adapter.ts`, `docs/adr/007-typed-graph-edges.md`, `test/store/*.test.ts`

## Approach

- New `doc_edges` table referencing `documents(id)`: `src_doc_id`, `dst_doc_id`, `edge_type` (free-form validated, **no CHECK** — vocab grows without migrations), `confidence`, `source`, `created_at`. `UNIQUE(src_doc_id, dst_doc_id, edge_type, source)` (provenance-lossless); dual indexes `(src_doc_id, edge_type)` + `(dst_doc_id, edge_type)`. Do **not** overload `link_type`.
- **Distinct types** in `src/store/types.ts` (avoid collision with existing `GraphEdgeConfidence` at `:428`): `DocEdgeType`/`RelationType` (validated lowercase string), `DocEdgeConfidence = parsed|configured|manual|inferred`, `DocEdgeSource = wikilink|markdown-link|frontmatter-relation`, plus `DocEdgeRow`/`DocEdgeInput` near `DocLinkRow/Input` (`:178-239`).
- Store API on `StorePort`: `setDocEdges(documentId, edges, source)` = **replace-by-source** (delete that doc's edges of `source`, bulk insert) mirroring `setDocLinks` (`adapter.ts:1803`); plus typed-edge read methods mirroring `getLinksForDoc`/`getBacklinksForDoc` (`:1867,:1926`). **Reads/traversal join `documents.active = 1` for both `src` and `dst`** so inactivated/renamed targets never surface stale. Dedup by `(src,dst,edge_type)` with confidence precedence **`manual > configured > parsed > inferred`**, tie-broken by `edgeSource` then docid/uri.
- **Stale-edge model (critical):** `doc_edges` caches a resolved `dst_doc_id`, but `markInactive()` soft-deletes (`documents.active = 0`, `adapter.ts:1038-1051`) so `ON DELETE CASCADE` won't fire. Add a **`backfillDocEdges()` projection service** — idempotent + transactional — that (re)derives edges for the **settled** document set; it is the post-migration backfill runner AND the sync-repair re-projection. `dst_doc_id` is a derived cache rebuilt by projection, not a hard referential contract. (Task .2 wires it into the sync post-upsert pass.)
- **Persist `content_type_source`** as a new column on `documents` (migration v10) — currently sync-result-only; diagnose (.4) needs to read it from the DB.
- Migration v10: additive/idempotent, PRAGMA-guarded, no-op `down` for table/column — follow `009-content-type-rule-fingerprint.ts`; register in `migrations/index.ts`. Schema migration stays separable from the data backfill.
- **Backfill reuses the resolver extracted in task .9** (`src/core/graph-resolver.ts`) — call the shared SQL helper builders instead of inlining a second resolver. Project resolved `doc_links` → `mentions`/`related_to` (`source: wikilink|markdown-link`, `confidence: parsed`). Parity test: backfilled edges == edges `getGraph` derives for the same data.
- ADR-007 records: derived-table choice, `UNIQUE(...,source)` + read dedup, free-form `edge_type`, distinct type names; references the .9 resolver extraction.

## Investigation targets

**Required:**

- `spec/db/schema.sql:243-266` — `doc_links` (CHECK/uniqueness style to mirror)
- `src/store/migrations/009-content-type-rule-fingerprint.ts` + `migrations/index.ts` — template + registration
- `src/store/sqlite/adapter.ts:1803-1926` — `setDocLinks`/read patterns to mirror
- `src/core/graph-resolver.ts` + `src/store/sqlite/adapter.ts:2301` — shared resolver helpers now used by `getGraph`; backfill must reuse them for parity
- `src/core/ref-parser.ts` — shared ref parser/resolver extracted in task .9 for non-CLI callers
- `src/store/types.ts:178-239,428` — `DocLinkRow/Input`, existing `GraphEdgeConfidence` (collision to avoid)

**Optional:**

- `docs/adr/000-template.md` — MADR template

## Acceptance

- [x] `doc_edges` lands via additive idempotent migration v10; `UNIQUE(src,dst,edge_type,source)` + dual indexes; no CHECK on `edge_type`
- [x] Distinct `DocEdgeType`/`RelationType`/`DocEdgeConfidence`/`DocEdgeSource` types (no collision with `GraphEdgeConfidence`)
- [x] `setDocEdges(documentId, edges, source)` replace-by-source + typed-edge read methods that join `documents.active=1` (src+dst) and dedup by `(src,dst,edge_type)` with precedence `manual>configured>parsed>inferred`
- [x] `backfillDocEdges()` projection service: idempotent, transactional, runnable post-migration and as sync-repair re-projection; no reliance on `ON DELETE CASCADE`
- [x] `content_type_source` persisted as a `documents` column via v10
- [x] Backfill reuses the **task .9** resolver helpers; **parity test** proves backfilled edges match `getGraph`-derived edges
- [x] Existing `linkType: wiki|markdown` APIs/schemas, `getGraph`, `gno links`/`gno backlinks` read paths unchanged on old data
- [x] ADR-007 records the data-model decision
- [x] Regression tests cover edge CRUD, replace-by-source, idempotency, backfill parity, backward compatibility

## Done summary
Added migration v10 and typed-edge storage/backfill foundation. doc_edges is additive, provenance-preserving, and read-deduped; store APIs expose replace-by-source writes plus active-doc-filtered outgoing/backlink reads. Link-derived backfill reuses the shared task .9 graph resolver helpers and preserves getGraph parity. content_type_source now persists through ingestion/upsert, and ADR-007 records the data-model decision.
## Evidence
- Commits:
- Tests: bun run lint:check, bun test test/store test/spec/schemas test/ingestion
- PRs: