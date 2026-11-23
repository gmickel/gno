---
satisfies: [R1, R2, R3, R4, R5, R6]
---
# fn-234-lossless-vector-search-hot-fixes-and-db.1 Implement Lossless vector search hot fixes and DB hygiene

## Description
TBD

## Acceptance
Every R-ID in the parent spec's ## Acceptance Criteria is satisfied; judge this task against the spec's criteria directly.

## Done summary
Implemented all fn-234 lossless vector search hot fixes and DB hygiene changes:

- **R1 (Durable per-partition `null_cosine` tracking):** Added migration v38 (`038-vector-mirror-null-cosine.ts`) adding nullable `null_cosine` to `vector_mirror_state` and updated `spec/db/schema.sql`. `VectorVariantStore` evaluates `vec_distance_cosine(?1, ?1) IS NULL` in SQL on writes (handling all-zero, float32 underflow `1e-30`, and overflow `1e30` embeddings) and maintains `(dirty, null_cosine)` across `write`/`writeCurrent`, `release`, `collectGarbage`, `activate`, and `syncIndex`. `checkNullCosineVariant` performs an O(1) PK lookup before the `vec0` fast path, falls back safely on unknown/downgraded rows or read-only connections, and persists after the read snapshot on the writer connection guarded by an unchanged `vector_variant_epoch`.
- **R2 (Skip unconditional `content_chunks` join):** `buildEligibleVariantQuerySpec` in `src/store/vector/variant-search.ts` joins `content_chunks` in the candidate subquery only when `eligibility.language` is set, preserving exact parity across single and batched scans (including missing chunk rows, multi-owner, stale-owner, and language filters).
- **R3 (Unified SQLite PRAGMA helper & `gno doctor` read-back):** Consolidated `temp_store`, `cache_size` (`-131072` primary / `-65536` read), and `mmap_size` (up to 8 GiB bounded by half of RAM on 64-bit, 256 MiB on 32-bit, keeping `page_size` 4096) into `applySqlitePerformancePragmas` across `open`, `openReadOnly`, and `openReadDb`, and added live read-back `sqlite-mmap` reporting in `gno doctor`.
- **R4 (Legacy vector hygiene & `gno vec prune`):** Added `partitionActiveNoLegacy` handling in `createVectorIndexPort` so active v1 partitions never recreate legacy `vec_<hash>` tables and search/sync/rebuild succeed without them; switched `stats.countVectors` to check activated partitions first; added `pruneLegacyVectors` and `gno vec prune [--vacuum] [--json]` wired with write lease flags and documented in `spec/cli.md` and `docs/CLI.md`.
- **R5 (`similar` query plan & CLI hydration parity):** Rewrote `listDocumentsForSimilarity` using `json_each(?) CROSS JOIN documents d` (PK and `INDEXED BY idx_documents_mirror_hash` seeks, zero `idx_documents_collection` scan or Bloom filter) and switched CLI `gno similar` to use `listDocumentsForSimilarity`.
- **R6 (Verification & benchmarks):** All gates pass (`bun run lint:check`, `bun run test:tmp-check` 6,554 pass / 0 fail, `eval:memory` 100%, `eval:sessions` 100%, `eval:hybrid` 86%, before/after `soak --tier smoke` PASS with 0 failures). Synthetic 100k × 1024d cold-process `vec0` median dropped from 252.1 ms to 102.2 ms (2.47x faster); isolated real-index copy (3,443.9 MiB, 46,818 1024d vectors, 13,777 scoped owners) measured 2.54 µs/vec warm (3.07 µs/vec fresh open) before `VACUUM INTO` and 3.15 µs/vec warm (3.40 µs/vec fresh open) after `VACUUM INTO` (3,430.1 MiB, 18.0 s).

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 9860ff1b6ae4d04b758208623da0be1b8fb4012a
- Tests: bun run lint:check, bun run test:tmp-check, bun test test/store/vector/fn-234-hotfixes.test.ts, bun run eval:memory, bun run eval:sessions, bun run eval:hybrid, bun run soak --tier smoke
- PRs: