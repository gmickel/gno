# Lossless SQLite and vector store performance

## Conversation Evidence

> user (turn 1): "This is gno, my amazing product. I want you to go through all and find potential performance gains at no loss in quality"
> user (turn 3, selected): "(Recommended) split-as-proposed (5 independent-outcome no-plan specs; Spec 2 depends on Spec 1; stat-cache excluded for fn-117)"
> user (turn 3, selected): "Enable PRAGMA synchronous = NORMAL in WAL mode in Spec 1 (crash-safe, faster bulk sync/embed writes; uncheckpointed commit can roll back on sudden power loss)"

## Goal & Context
<!-- scope: business -->
<!-- Source: 20% user / 20% [paraphrase] / 60% [inferred] -->

Reduce latency, disk I/O, and CPU overhead across GNO's SQLite and vector storage layer with zero loss in retrieval rankings, recall, provenance accuracy, or schema safety. Local benchmarks on a 5,000-chunk, 768-dimension index show that missing SQLite runtime PRAGMAs, missing covering indexes on `vector_owners`, double-writes during variant embedding persistence, N+1 proof and garbage-collection queries, and repeated full-table scans during status and document hydration account for the largest avoidable latency in the store layer.

## Architecture & Data Models
<!-- scope: technical -->

1. **SQLite connection PRAGMAs:** Configure `PRAGMA cache_size = -64000` (read-only/secondary connections `-32000`), `PRAGMA temp_store = MEMORY`, `PRAGMA mmap_size = 268435456`, and `PRAGMA synchronous = NORMAL` (on WAL-mode writable connections outside CI, while keeping CI's `synchronous = OFF`) across all database open paths.
2. **Schema migration (covering and cleanup indexes):**
   - Add `idx_vector_owners_partition_variant ON vector_owners(partition_id, variant_id, mirror_hash, seq, document_id)`.
   - Add `idx_vector_owners_doc_part ON vector_owners(document_id, partition_id, seq, mirror_hash, variant_id)`.
   - Add `idx_vector_owners_mirror_seq ON vector_owners(mirror_hash, seq)` so chunk deletions and re-chunking never scan `vector_owners`.
   - Add `idx_retrieval_traces_created ON retrieval_traces(created_at_ms DESC, trace_id ASC)`.
   - Add partial `idx_documents_collection_mtime ON documents(collection, source_mtime DESC, id ASC) WHERE active = 1`.
   - Replace `idx_doc_tags_tag(tag)` with covering `idx_doc_tags_tag_doc(tag, document_id)` and replace `COUNT(DISTINCT dt.document_id)` with `COUNT(*)` in tag-count queries (unique by `(document_id, tag)` PK).
   - Drop 5 strictly redundant left-prefix indexes with zero `INDEXED BY` references: `idx_chunks_mirror_hash`, `idx_doc_links_source_doc`, `idx_doc_edges_src_type`, `idx_doc_edges_dst_type`, `idx_vectors_model`.
3. **Variant vector search and proof cache:**
   - Join `vector_variants` via `CROSS JOIN` after grouped owner selection; when selective document filters are active, drive from the eligible document query `CROSS JOIN vector_owners` using `idx_vector_owners_doc_part`; when unscoped, drive from `vector_owners` using `idx_vector_owners_partition_variant`.
   - Key the per-connection `provenOwners` cache on `vector_variant_epoch.epoch` instead of `pragma_data_version` + `total_changes()`, skipping cache population when already inside an outer uncommitted transaction (`db.inTransaction` before search begins).
   - Batch uncached candidate owner proof queries into a single `json_each(?)` query per page, stop proving and stop `limit *= 4` retries once `1 - row.distance < minScore`, and merge redundant `vector_partitions` lookups.
4. **Variant writes, GC, and mirror sync:**
   - Fix `writeRows` so newly inserted variants do not immediately run a redundant `UPDATE`, two BLOB read-backs, and a needless `vec0` delete; use `INSERT ... RETURNING variant_id`, batch-validate owners in one SQL query, bind zero-copy `Uint8Array` views, and reuse cached `db.query()` statements.
   - Rewrite `removeUnowned()` and `owners()` to drop unused `embedding` BLOB reads, fast-delete zero-active-owner variants in SQL, stream remaining candidates ordered by `variant_id`, consult the epoch-keyed proof cache, and short-circuit on the first valid owner.
   - Replace `candidates()` correlated subqueries with `LEFT JOIN vector_owners INDEXED BY idx_vector_owners_doc_part` and `LEFT JOIN vector_variants`.
   - Rewrite `vec0` rebuild/sync (`rebuildPartitionIndex`, `syncPartitionIndex`, `syncIndex`, `rebuildVecIndex`, `syncVecIndex`) as pure SQL `INSERT INTO ... SELECT ...` inside transactions so embedding BLOBs never cross the SQLite-to-JS boundary.
   - In legacy vector paths, drive selective eligibility searches from `SELECT DISTINCT mirror_hash`, merge `upsert()` into one transaction with a `SAVEPOINT` around best-effort `vec0` writes, replace 800-hash batch loops with `json_each(?)`, and collapse double `NOT EXISTS` in backlog stats into one `LEFT JOIN`.
5. **Status, row hydration, FTS rebuilds, eligibility, backlinks, and trace queries:**
   - Skip discarded legacy vector CTEs and backlog scans in `getStatus()` when `variantStatus !== null`; merge `documents` scans into one pass; share the epoch-keyed proof cache in `getVariantStatus` and avoid fetching `c.text` for unbound or already-proven rows.
   - Replace Zod `typedMetadataSchema.parse(JSON.parse(...))` in `mapDocumentRow` (which re-stringifies and UTF-8 encodes metadata on every row read) with a direct validator checking `Buffer.byteLength(raw, "utf8") <= 65536`; use `INSERT ... ON CONFLICT DO UPDATE ... RETURNING id` in `upsertDocument` and construct the change-journal snapshot directly from in-memory fields.
   - Replace dynamic `IN (?,...)` `db.query()` statements with `IN (SELECT value FROM json_each(?))` and convert fixed-SQL `db.run`/`db.prepare` loops to cached `db.query()`.
   - Update `fts_mirror_hash` once per document in single-doc FTS sync and rewrite full FTS rebuild as pure SQL `INSERT INTO documents_fts SELECT ...`.
   - Omit `LEFT JOIN content_chunks` in document eligibility queries when `exclude` is unset; hoist lowercased filter terms and check document-level metadata once per document instead of once per chunk; hoist eligibility query building outside `getDocumentsByDocids` batches.
   - Partition `getBacklinksForDoc` candidates so link resolution runs only for workspace links; push wiki exact and suffix filters into SQL in graph-neighbor queries and batch markdown seed lookups; replace N+1 queries in refactor-resolution snapshots with chunked/streaming joins.
   - Compute `lower(text)` once per chunk in `getChunkTermPresence` and use a single `instr` check for lowercase ASCII terms; simplify `metadata-predicate` SQL (`json_type`/`json_extract` for safe identifier keys, single-pass `all`/`in`/`nin`); batch trace export bundles and rewrite trace retention storage queries as `GROUP BY` CTEs.
   - Query `seq = 0` first for similarity source vectors (falling back to `seq > 0` only when missing), normalize in-place, and compute only the upper triangle of symmetric graph similarity dot products with a bounded top-K buffer.

## API Contracts
<!-- scope: technical -->

- No public CLI, REST, MCP, or SDK contract changes.
- All `StorePort` and `VectorIndexPort` method signatures, return shapes, tie-break orderings, and error codes remain unchanged.
- Schema migration is strictly forward-compatible and idempotent on existing v36 databases.

## Edge Cases & Constraints
<!-- scope: technical -->

- **Rollback safety for proof cache:** When `searchVectorVariants` runs inside an already-open caller transaction (`db.inTransaction`), it must not write unvalidated proofs into the connection-shared cache so a later `ROLLBACK` cannot leave stale proofs behind.
- **Stale SQLite statistics:** Join order pins (`CROSS JOIN`, `INDEXED BY`) must hold even when `sqlite_stat1` is stale or absent (consistent with existing production-stats tests).
- **WAL durability boundary:** `PRAGMA synchronous = NORMAL` applies only to WAL-mode writable connections (keeping `PRAGMA synchronous = OFF` when `process.env.CI` is set). If WAL mode could not be enabled due to lock contention at open, leave `synchronous` at default `FULL`.
- **Fallback for `mmap_size`:** Setting `PRAGMA mmap_size` must never fail database open on platforms or filesystems that ignore or clamp mmap; wrap or rely on SQLite's non-error clamp behavior.
- **Exact parity:** Unicode `.toLowerCase()` exclusions, IEEE-754 distance and `minScore` thresholds, tie-break ordering, and `typedMetadata` validation rejection rules must remain identical to current behavior.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** All SQLite connection openers set `PRAGMA cache_size` (`-64000` primary, `-32000` secondary read connection), `PRAGMA temp_store = MEMORY`, and `PRAGMA mmap_size = 268435456`, and writable WAL-mode connections (outside CI) set `PRAGMA synchronous = NORMAL`. Errors: if WAL mode is not active, `synchronous` remains `FULL`; no connection open fails if the OS clamps `mmap_size`. [paraphrase]
- **R2:** A new forward migration creates covering indexes on `vector_owners` (`(partition_id, variant_id, mirror_hash, seq, document_id)`, `(document_id, partition_id, seq, mirror_hash, variant_id)`, `(mirror_hash, seq)`), `retrieval_traces(created_at_ms DESC, trace_id ASC)`, partial `documents(collection, source_mtime DESC, id ASC) WHERE active = 1`, and `doc_tags(tag, document_id)`, and drops the 5 redundant left-prefix indexes. Errors: migration runs cleanly on both fresh and upgraded databases with existing data; `EXPLAIN QUERY PLAN` verifies zero `SCAN vector_owners` on scoped/unscoped variant search and chunk deletion, and zero `AUTOMATIC COVERING INDEX` on scoped variant search. [inferred]
- **R3:** Variant vector search drives selective filtered queries from eligible documents via `idx_vector_owners_doc_part` and unscoped queries via `idx_vector_owners_partition_variant`, keys its proof cache on `vector_variant_epoch.epoch` (skipping shared-cache writes inside nested uncommitted transactions), batches cold-cache owner proofs into one SQL query per page, and stops proving/retrying as soon as `1 - distance < minScore`. Errors: identical results, ordering, error codes, and rollback isolation as current implementation. [inferred]
- **R4:** `VectorVariantStore.writeRows` writes each newly embedded variant once (using `INSERT ... RETURNING variant_id` and `else if (embedding)`), batch-validates owners once per transaction, reuses cached prepared statements, and `removeUnowned()` deletes unowned variants without reading `embedding` BLOBs or running N+1 per-owner queries. Errors: invalid dimensions, non-finite floats, and stale owners fail closed with the same error semantics and leave the transaction rolled back. [inferred]
- **R5:** Vec0 mirror sync/rebuild and full FTS5 rebuild execute via pure SQL `INSERT INTO ... SELECT ...` inside transactions without loading all BLOBs or document bodies into JS memory; legacy vector `upsert` commits `content_vectors` and best-effort `vec0` in one outer transaction with a `SAVEPOINT` around `vec0`. Errors: `vec0` write failures roll back only the savepoint, set `vecDirty`, and preserve committed `content_vectors` rows identically. [inferred]
- **R6:** `getStatus()` and `getVariantStatus()` skip legacy vector scans when `variantStatus !== null`, consolidate `documents` table scans, and reuse the epoch-keyed proof cache without fetching unused `c.text`. Errors: all reported counts, partition states, and error paths match existing status contracts identically. [inferred]
- **R7:** `mapDocumentRow()` validates `typed_metadata` without re-serializing via `JSON.stringify` + `TextEncoder`, and `upsertDocument()` uses `RETURNING id` and builds change-journal snapshots without extra `SELECT *` or `mapDocumentRow()` calls. Errors: malformed, reserved-key, or >64 KiB `typed_metadata` values are rejected with identical error behavior. [inferred]
- **R8:** Dynamic `IN (?,...)` queries use `json_each(?)` with cached `db.query()` statements; document eligibility skips joining `content_chunks` when `exclude` is absent and evaluates document-level metadata once per document; backlinks skip workspace resolution for non-workspace links; graph-neighbor wiki lookup pushes filters into SQL; refactor-resolution snapshot batches candidate reads; `getChunkTermPresence` computes `lower(text)` once per chunk; metadata predicates use `json_type`/`json_extract` for safe keys; trace retention and export bundles eliminate correlated subqueries and N+1 loops; similarity vectors fetch `seq = 0` first and graph similarity computes only the upper triangle. Errors: all store contract, graph, trace, metadata, and >999-ID batch tests pass with identical results and zero retrieval quality regression (`bun run eval:memory` and `bun run eval:sessions` remain at 100%). [inferred]

## Boundaries
<!-- scope: business -->

- No changes to ranking formulas, similarity thresholds, tie-break rules, or embedding/chunking outputs.
- No inverted `doc_metadata_kv` table in this spec (keep metadata predicate improvements SQL-only; evaluate an inverted table only if measured needed later).
- No changes to retrieval pipeline orchestration, `vec0` fast-path search dispatch, or multi-query batching (owned by sibling Spec 2).
- No changes to ingestion walker, converters, CLI startup, serve routes, or native worker IPC (owned by sibling Specs 3, 4, and 5).

## Decision Context
<!-- scope: both -->

Part of a 5-spec lossless performance series from the v2.15.0 full-codebase performance audit (sibling specs: Spec 2 retrieval/verification pipeline [depends on this spec], Spec 3 ingestion/converters/graph sync, Spec 4 CLI/serve/watcher/Web UI/MCP, Spec 5 LLM worker/memory/capsule/sessions).

The user explicitly opted into `PRAGMA synchronous = NORMAL` on WAL-mode writable connections (accepting that an uncheckpointed commit right before sudden power loss can roll back, while keeping full crash safety and zero corruption risk) alongside the strictly zero-durability-impact PRAGMAs (`cache_size`, `temp_store = MEMORY`, `mmap_size`, measured at `-39%` vector scan latency on 5,000 x 768d chunks). Keeping this store foundation in Spec 1 gives Spec 2 clean covering indexes, epoch-keyed proofs, and reliable query plans to build on. [paraphrase]
