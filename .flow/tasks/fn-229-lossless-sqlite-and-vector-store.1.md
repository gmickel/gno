---
satisfies: [R1, R2, R3, R4, R5, R6, R7, R8]
---
# fn-229-lossless-sqlite-and-vector-store.1 Implement Lossless SQLite and vector store performance

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Implemented all lossless SQLite and vector store performance improvements for `fn-229-lossless-sqlite-and-vector-store` (R1–R8) with full behavioral parity and regression tests:

- **R1 (SQLite connection PRAGMAs):** Configured `cache_size = -65536`, `temp_store = MEMORY`, `mmap_size = 268435456`, and `synchronous = NORMAL` (WAL outside CI) in `SqliteAdapter.open`, with `ANALYZE` after migrations.
- **R2 (Schema migration 037):** Added covering indexes (`idx_vector_owners_mirror_seq`, `idx_vector_owners_doc_part`, `idx_vector_owners_partition_variant`, `idx_documents_collection_active_source`, `idx_documents_active_relpath`, `idx_doc_links_wiki_target`, `idx_doc_links_md_target`, `idx_retrieval_traces_started_id`, `idx_retrieval_traces_terminal_started`) with clean `down()` rollback and `EXPLAIN QUERY PLAN` assertions.
- **R3 (Vector search proof cache & batching):** Shared `vector_variant_epoch` proof cache in `src/store/vector/proof-cache.ts` (preserving transaction rollback isolation and cross-connection invalidation), batched owner-input proof fetches via `json_each(?)`, `minScore` early cutoff (with `NaN` empty-result guard), and single-snapshot deferred reads.
- **R4 (Variant writes & mirror sync):** Single-statement `INSERT ... RETURNING variant_id` on fresh variant inserts (replacing stale orphan `vec0` rows only on `UNIQUE` collision), correlated-subquery backlog candidate probing without Bloom filters, and SQL-only partition mirror sync/rebuild.
- **R5 (Legacy sqlite-vec):** Pure-SQL `rebuildVecIndex` and `syncVecIndex` (reporting exact logical counts via `SELECT changes()`) and single `SAVEPOINT` for batch `upsertVectors`.
- **R6 (Variant status):** Deferred `content_chunks.text` reads in `getVariantStatus` to uncached bound rows, fetching and proving in 512-chunk batches inside one read snapshot, and omitted legacy CTE when `embedModel` is scoped.
- **R7 (Typed metadata):** Added direct stored-metadata validator `parseStoredTypedMetadata` with exact canonical UTF-8 size bound (`rawBytes + numberCount * 24 <= 65536` fast path, `JSON.stringify` fallback otherwise).
- **R8 (Hot SQL queries):** Replaced `IN (?,?,...)` chunk loops with `json_each(?)` across hydration/tag/stats/link/similarity paths, preserved single-batch (`<= 800`) and multi-batch (`> 800`) `NULL`-distance parity in `allowedMirrorHashes`, replaced `LIKE` suffix filters in `graph-neighbors.ts` with literal `length`/`substr` checks, materialized `scoped` CTE in `getChunkTermPresence` (`lower(text)` once per chunk), added `seq = 0`-first single-snapshot similarity source reads, upper-triangle similarity edge loop, and `json_type`/`json_extract` fast path in `metadata-predicate.ts`.

### Verification

- `bun test test/store/ test/embed/variant-backlog-scope.test.ts test/pipeline/eligible-top-k.test.ts test/pipeline/typed-metadata.test.ts` — 467 pass, 0 fail (8831 assertions)
- `bun run typecheck` — 0 errors
- `oxlint --type-aware --type-check` on all touched files — 0 warnings, 0 errors
- `bun run eval:memory` — 100% PASS
- `bun run eval:sessions` — 100% PASS (35/35)
- `bun run bench:vector-search -- --chunks 5000 --dims 768` — unscoped 7.9 ms p50 (vs 14.86 ms baseline, -47%), collection 0.9 ms p50, metadata 0.9 ms p50

### Review

- stage: impl-review - ran (codex:gpt-6.2-sol:medium, 3 rounds -> SHIP)
- Round 1 (3-axis fan-out): 12 introduced findings (9 fixed in `fd5cefdf`, 3 non-contractual P2s #10/#11/#12 declined and subsequently withdrawn by Codex in Round 2; 1 pre-existing `substr`/NUL finding omitted from merge plan as unchanged from base `14ae1f85:src/store/sqlite/adapter.ts:4813`).
- Round 2: 2 P1 findings on fix commits -> fixed in `36e9a8e3`.
- Round 3: `SHIP` (0 introduced, 0 pre_existing, 0 unaddressed; R1–R8 all met).

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: aea9b329cae157f6429cee27b6b11db7753117d5, fd5cefdfd898efd518ed901300f22b889212b4c2, 36e9a8e368da8729535c5f71e72004ba3b02c9c1
- Tests: bun test test/store/ test/embed/variant-backlog-scope.test.ts test/pipeline/eligible-top-k.test.ts test/pipeline/typed-metadata.test.ts, bun run typecheck, bun run eval:memory, bun run eval:sessions
- PRs: