# Bit coarse vec0 mirror with exact rescore and cost-based routing

## Conversation Evidence

> user (turn 2): "ok why intentional, we're seeing perf problems with very large collections etc"
> user (turn 4): "...print a list of the things we can and should tweak that will massively help without adding ANN"
> user (turn 5): "does 7 break existing collections?"
> user (turn 6): "...yes we will do the benchmark but hold off until we've finished scoping everything"
> user (turn 6, attached live measurements): "Our searches always pass --collection (the access scope), so they hit #1: the exact path, bypassing vec0... After 'documents only' (40-80k vectors, -95%), expected vector stage at ~8 µs per vector is ~0.6-0.9 s. Per-collection partition key plus quantized scan would cover us; ANN only matters for much larger corpora."
> user (turn 7): "capture the specs in full detail including all research and everything..."
> user (after the benchmark spike): "ok redo the specs accordingly"

## Goal & Context
<!-- scope: business -->
<!-- Source: 25% user / 25% [paraphrase] / 50% [inferred] -->

Vector search over a large scope is slow because every exact path reads every float32 vector in scope. At 1.34M vectors of 1024 dimensions a float32 `vec0` scan takes 2.1 to 2.3 s warm and the exact SQL scan takes about 2.5 s. Multi-query expansion multiplies that.

The benchmark spike (2026-11-23, Bun 1.4.2, SQLite 3.53.2, `sqlite-vec 0.1.9`) changed the plan in three ways.

- **A float32 mirror partitioned by collection is not worth building.** The exact SQL scan already costs only the eligible rows. 45k eligible rows took 84 ms. The 50k float32 partition took 75 ms. That is about 1.9 µs against 1.5 µs per vector.
- **A `bit` mirror changes the order of magnitude.** `bit[1024]` Hamming search costs 0.05 to 0.23 µs per vector for `k` up to 250. At 1.34M vectors that is about 306 ms at `k = 250`, and the mirror is 194 MB against 5.15 GB for float32.
- **`rowid IN` never pays for filtered searches.** Float32 `vec0` with `rowid IN` lost to the exact SQL scan at every selectivity from 0.1% to 90%.

This spec adds a `bit` coarse `vec0` mirror partitioned by collection, an exact float32 rescore from `vector_variants`, and a cost-based router. Small scopes and every filtered search stay on the exact paths and stay bit-identical to v2.16.0. Large unfiltered scopes take the two-stage path, whose scores are exact and whose candidate set is approximate. It needs no re-embedding and no new dependency. It replaces the earlier Spec 2 (collection-partitioned float32 mirror) and Spec 3 (quantized two-stage search). [strategy:Trustworthy retrieval and evidence] [strategy:Local knowledge lifecycle] [strategy:Coherent agent and application surfaces]

## Architecture & Data Models
<!-- scope: technical -->

### Spike measurements this design rests on

Recall of two-stage `bit[1024]` search against exhaustive float32, on 46,780 real 1024-dimension vectors, 25 natural-language queries (asymmetric) and 100 leave-one-out document queries (symmetric):

| coarseK | Asym R@10 (min) | Asym nDCG@10 | Asym top-1 | Asym R@20 | Sym R@10 (min) |
|---:|---:|---:|---:|---:|---:|
| 50 | 89.2% (60%) | 99.32% | 100% | 80.6% | 98.8% (80%) |
| 100 | 95.6% (80%) | 99.88% | 100% | 91.8% | 99.5% (80%) |
| 200 | 99.2% (90%) | 99.94% | 100% | 96.0% | 99.8% (80%) |
| 250 | 99.6% (90%) | 99.94% | 100% | 97.2% | 99.9% (90%) |
| 500 | 99.6% (90%) | 99.94% | 100% | 99.0% | 100% (100%) |
| 1000 | 100% (100%) | 100% | 100% | 100% | 100% (100%) |

Stage 1 cost grows with `k`, because top-k insertion dominates the Hamming arithmetic:

| `k` | µs per vector | Projected at 1.34M |
|---:|---:|---:|
| 20 | 0.05 | 73 ms |
| 100 | 0.10 | 134 ms |
| 200 | 0.18 | 246 ms |
| 250 | 0.23 | 306 ms |
| 500 | 0.49 | 656 ms (measured 649 to 665 ms) |
| 1000 | 1.15 | 1,539 ms |
| float32, `k = 20` | 1.43 | 1,917 ms (measured 2,120 to 2,305 ms) |

Other results:

| Measurement | Result |
|---|---|
| Stage 2 rescore of 500 rows at 1.34M | 5.5 ms warm, 120 to 250 ms cold |
| `int8[1024]` | 100% recall, no faster than float32 (690 ms against 678 ms at 450k), 1.31 GB at 1.34M |
| Footprint at 1.34M | `vector_variants` 5.75 GB, float32 `vec0` 5.15 GB, `bit` `vec0` 0.19 GB |
| Mirror build at 500k | `bit` 2.6 s, float32 partitioned 86.7 s |
| Per-partition overhead, one row | `bit` 0.135 MB, float32 4.01 MB, float32 plus `bit` 4.14 MB |
| Exact SQL scan, one query | about 1.9 µs per eligible vector |
| Exact SQL scan, four queries in one pass | 1,953 ms at 450k, against 2,671 ms for four float32 `vec0` queries |
| Four `bit(500)` queries with rescore, 450k unfiltered | 849 ms |
| `bit(500)` with `rowid IN` against the exact scan | wins only at 50% selectivity and above, by under 20% |
| `rowid IN` values | compared in 32 bits: `2^32 + 5` matches rowid 5 |
| `vec_quantize_binary` on a length not divisible by 8 | throws |
| `bit` KNN query vector | must be `vec_quantize_binary(?)`; a raw BLOB is parsed as float32 |
| Partition key `IN (a, b)` | rows unsorted across partitions |
| `NULL` distances | sorted last by `vec0`, first by SQLite |
| A trigger or a table drop that touches a `vec0` table without the extension | fails with `no such module: vec0` |

### 1. `bit` mirror layout (additive, downgrade-safe)
- **Table:** one per activated partition whose dimensions are divisible by 8.
  ```sql
  CREATE VIRTUAL TABLE IF NOT EXISTS vec_v2_<partitionId> USING vec0(
    collection TEXT PARTITION KEY,
    coarse bit[<dimensions>]
  );
  ```
  `coarse` is filled in SQL with `vec_quantize_binary(v.embedding)`. No embedding BLOB crosses into JS during a build.
- **`vec_v1_<partitionId>` is untouched.** Older binaries keep their float32 mirror, and this spec keeps using it for clean unscoped exact searches. Total vector storage at 1.34M goes from 10.9 GB to 11.1 GB.
- **Mapping table:** `vector_partition_rows (id INTEGER PRIMARY KEY, partition_id TEXT NOT NULL, collection TEXT NOT NULL, variant_id INTEGER NOT NULL, UNIQUE(partition_id, collection, variant_id))` plus an index on `(partition_id, variant_id)`. `id` is the `vec0` rowid. This spec never passes these ids to `rowid IN`.
- **Membership is a superset:** one row per `(collection, variant_id)` for which any `vector_owners` row binds the variant to a document of that collection, active or not. Stage 2 filters stale owners as the v1 path does today. Stale rows cost candidates, never correctness.
  - Document sync writes `documents` on a connection that does not load sqlite-vec, so the mirror must not depend on `documents.active` or `documents.mirror_hash`.
  - A document belongs to one collection for its whole life. `gno collection rename` removes the old name's documents and re-indexes under the new name.
  - Rows are added by `VectorVariantStore` writes and removed by `removeUnowned()`, `gno vec sync`, `gno vec rebuild` and partition drop.
- **State table:** `vector_mirror_v2_state (partition_id TEXT PRIMARY KEY, dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)), check_recall REAL, check_queries INTEGER, check_coarse_k INTEGER)`. `vector_mirror_state` keeps its shape, because older binaries read and replace its rows by `partition_id` alone.
  - Delete-only triggers on `vector_variants` (insert, update, delete) and `vector_owners` (insert, update) remove the row. They write only this plain table. No trigger references a `vec0` table and none is added to `documents`.
  - `VectorVariantStore` updates `vector_partition_rows` and `vec_v2_*` inside the transaction of each write and restores the row it found, as `keepingMirrorMark` does for v1.
  - A write from an older binary fires the triggers and leaves v2 dirty until the next `gno vec sync`.
- **Embed must see v2 state:** `mirrorState()` in `src/store/vector/variants.ts` checks only `vec_v1_*` today, and `src/embed/variant-backlog.ts` uses it to decide whether an embed run repairs mirrors. Add a v2 state check beside it, so an upgraded index with a clean `vec_v1` and a missing or dirty `vec_v2` gets its v2 mirror built at the end of the next `gno embed`. `activate()` builds the v2 mirror with the partition but does not require it for activation.
- **Lifecycle paths that must handle v2:** the `VectorVariantStore` constructor, `write`/`writeCurrent`, `release`, `collectGarbage`, `activate()`, `mirrorState()` and its caller in `src/embed/variant-backlog.ts`, `syncIndex()`, `syncPartitionIndex`, `rebuildPartitionIndex`, the one-time partition re-key in `src/store/vector/runtime-compat.ts`, `dropVectorPartition` in `src/store/vector/status.ts`, and Spec 1's prune (orphaned `vec_v2_*` tables, mapping rows and state rows).
- **Never built on a read:** the mirror is created and repaired only by `gno embed`, `gno vec sync` and `gno vec rebuild`.

### 2. Build-time recall self-check
Binary quantization quality depends on the embedding model. The spike measured one model at 46.8k vectors.
- **Purpose:** catch an embedding model whose vectors binarize badly. Fine-grained quality is R1's job.
- **When:** after `gno vec sync` or `gno vec rebuild` builds or repairs a mirror, and at the end of a `gno embed` run, whenever the partition is above the exact-cost budget, the mirror is clean and `check_recall` is `NULL`. A fresh index built only by `gno embed` therefore reaches the two-stage route without a manual sync.
- **How:** sample 16 stored vectors spread evenly over `variant_id`, compute their exact top-10 in one streaming pass over `vector_variants`, run the same 16 through the two-stage path at `coarseK = 200`, and store mean recall@10, the query count and the `coarseK` in the state row.
- **Cost:** the pass costs about `N * (1.05 + 0.82 * 16)` µs, which is about 19 s at 1.34M vectors on a freshly built file and more on a fragmented one. The cost comes from the 16 cosine evaluations per row, so the number of passes does not change it. The check runs once per build, never on a search.
- **Floor:** the two-stage path is used only when `check_recall >= 0.95` (at most 8 misses in 160 slots). Symmetric recall at `coarseK = 200` was 99.8% in the spike, so a healthy model clears the floor with margin and 16 queries are enough to see a model that does not.
- A partition under the budget skips the check, because the router never sends it to the two-stage path.
- `VectorVariantStore` writes keep the stored check values. Only a build or repair recomputes them.

### 3. Cost-based router
The router chooses a path per search. Every path returns exact float32 scores. Inputs: `Q` distinct query vectors, `k` per query, the scope, and `N`, the number of mirror rows in the scanned partitions (an indexed count on `vector_partition_rows`, cached per connection on the variant epoch).

| # | Condition | Route |
|---|---|---|
| 1 | Any filter beyond `collection` / `collections` (typed `filter`, tags, dates, categories, author, `relPathPrefix`, memory scopes, `excludeSuperseded`, `exclude`, `eligibility.language`, `chunkLanguage`, `allowedMirrorHashes`) | Exact SQL scan, batched when `Q > 1` |
| 2 | Mirror missing or dirty, self-check absent or below the floor, null-cosine flag not `0`, dimensions not divisible by 8, coarse search switched off | Existing exact paths |
| 3 | Estimated exact cost within the budget: `N * (1.05 + 0.82 * Q)` µs at most 100 ms | Existing exact paths |
| 4 | `k` above `maxCoarseQueryK` (40) | Existing exact paths |
| 5 | Otherwise | Two-stage: `bit` coarse search per query, then exact rescore |

- **Existing exact paths** means today's behaviour: the clean `vec_v1` fast path for unscoped searches, the exact SQL scan otherwise, batched for `Q > 1`.
- **`coarseK = clamp(25 * k, 200, 500)`.** Above 500 the `bit` scan costs as much as float32. A 25× factor reaches 500 at `k = 20`. For `k` from 21 to 40 the factor falls to 12.5×, which R1 must show is enough for the final top-`limit` after fusion. Hybrid asks the vector leg for `limit * 2`, and three times that with post-filters or recency sort.
- **The constants (`100 ms`, `25`, `200`, `500`, `40`, the cost coefficients) live in one module** and are pinned by R1.
- **Filtered searches never use the mirror.** `rowid IN` does not shorten a scan and compares rowids in 32 bits.
- **Rule 1 uses the selective-eligibility test, not "any option set".** Hybrid and vsearch always set the mode flags `excludeMetadata` and `semanticMetadata`. They are not filters. Rule 1 matches what `hasSelectiveEligibility` in `src/store/vector/variant-search.ts` treats as selective, plus `eligibility.language`, with `collection` and `collections` removed.
- **Default scoped queries pass rule 1 (verified).** A default `gno query -c X` or `gno vsearch -c X` sets no `memoryFilter`, `excludeSuperseded` or `retrievalScope` (`src/pipeline/hybrid.ts`, `src/pipeline/vsearch.ts`). A natural-language date query fills `since`/`until` and routes to the exact filtered scan, as it should.
- **Default `k` is 40 for structured output.** `gno query` and `gno vsearch` default `limit` to 20 with `--json`, `--md` or `--files` and to 5 otherwise, so the original vector leg asks for 40 or 10 and expansion variants for 20 or 5. At `k = 40` and `k = 20` the `coarseK` is 500, which costs about 650 ms per query at 1.34M. At `k = 10` it is 250, about 306 ms.

### 4. Two-stage execution
Both stages run inside the search's single read snapshot.
1. **Stage 1:** `SELECT rowid, distance FROM vec_v2_<partitionId> WHERE coarse MATCH vec_quantize_binary(?) AND k = ? [AND collection = ?]`.
   - One collection: the partition key.
   - Several collections: one query per collection, candidates unioned. If `collections.length * coarseK > 2000`, take the exact path.
   - Unscoped: no partition constraint. A variant shared by several collections appears once per collection and is deduplicated in stage 2.
2. **Stage 2:** map rowids to distinct `variant_id`s through `vector_partition_rows`, compute `vec_distance_cosine(v.embedding, ?)` against `vector_variants` for those variants only, hydrate owners through the same eligible-documents join and collection scope as the exact scan, run `proveUnknownOwners`, apply `minScore` to the exact distance, sort by `(distance, mirrorHash, seq, variantId)`, and return the first `k`.
   - A `variant_id` can be owned by documents in other collections. Those owners must never appear in `documentIds`. Collection is the access-control scope.
3. **Underfill:** if fewer than `k` proven results remain, stage 1 returned a full `coarseK`, and no candidate fell below `minScore`, rerun the query on the exact path. `coarseK` is never raised past 500.
4. **Batches:** `Q` stage-1 queries in the same snapshot, one shared proof pass. Identical query vectors are deduplicated before dispatch, as today.

### 5. Collection-scoped `gno similar`
- CLI, MCP and REST `similar` pass `eligibility: { collection: doc.collection }` when not cross-collection, so the search covers only that collection instead of taking the global top 200 and post-filtering in JS.
- `similar` asks for up to 200 candidates, which is above `maxCoarseQueryK`, so it always runs exact. A collection scope alone is not a rule 1 filter, so it uses the exact SQL scan over that collection.

### 6. Inspection and control
- `--explain` and the retrieval trace record the vector route (`exact-sql`, `exact-vec0` or `coarse-bit`), `N`, and for the two-stage path `coarseK` and the number of rescored variants.
- One config switch turns coarse search off for the index. `VectorSearchOptions` gains an internal `exact` flag used by the self-check, the benchmark and the evals.
- `gno status` and `gno doctor` report the v2 mirror state (missing, dirty, clean) and the stored self-check recall, with `gno vec sync` as the repair.

## API Contracts
<!-- scope: technical -->

- **No breaking changes** to `StorePort`, `VectorIndexPort`, CLI/MCP/REST/SDK response shapes, score scale (`1 - exactCosineDistance`) or `minScore` semantics. Returned scores and cutoffs are always exact float32 cosine.
- Searches on the exact routes return results identical to v2.16.0, including tie-break order `(distance, mirrorHash, seq, variantId)`.
- Searches on the two-stage route may omit a result that exhaustive search would return. Every result they return carries its exact score and proven owners.
- `--explain` output and the trace schema gain the route fields. `spec/cli.md`, `spec/mcp.md` and the affected `spec/output-schemas/*.json` are updated first, with contract tests.
- `gno vec sync` and `gno vec rebuild` build and repair the v2 mirror from `vector_variants` without loading an embedding model, and report its counts.
- Forward migration (v39) is additive and idempotent. An index without a v2 mirror behaves exactly as before.

## Edge Cases & Constraints
<!-- scope: technical -->

- **Zero re-embedding:** building or dropping the mirror never changes `vector_variants`, `vector_owners` or `vector_partitions.state`.
- **Triggers never touch `vec0`:** a trigger that references a `vec0` table fails with `no such module: vec0` on any connection without the extension, which would break document sync and older binaries.
- **Null-cosine partitions:** the two-stage path requires Spec 1's flag to be `0`, decided by the exact SQL predicate.
- **Dimensions not divisible by 8:** no mirror is created and the partition stays on the exact paths. `CREATE` of such a `bit[N]` column succeeds, so GNO checks first.
- **Stale superset rows:** inactive or re-chunked owners leave rows behind. Stage 2 drops them, underfill falls back to exact, and garbage collection or the next sync removes them.
- **Many small collections:** each partition allocates one chunk, 0.135 MB for `bit[1024]`. 1,000 collections cost about 135 MB.
- **Cold stage 2:** rescoring 500 rows read 120 to 250 ms cold at 1.34M. With `coarseK` at most 500 this stays a fraction of the saved scan.
- **Downgrade:** older binaries ignore `vec_v2_*`. Their `dropVectorPartition` and re-key leave orphaned v2 tables and rows, which Spec 1's prune removes.
- **Read-only connections:** a missing or dirty mirror never triggers a write. The search takes an exact path.
- **Depends on Spec 1:** the durable null-cosine flag, the `content_chunks` skip on the exact scan, and prune.
- **Zero other-product references:** no external product names in code, specs, commits, docs, or site copy.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** Before the two-stage route is enabled by default, recall is measured on at least 500k real stored vectors and on the `eval:hybrid` corpus: vector-leg R@`k` for `k` in 10, 20 and 40 at the router's `coarseK`, and the overlap of the final top-`limit` after fusion and rerank between two-stage and exact. The run pins the router constants. Errors: if recall is below the agreed floor (vector-leg R@10 of 99% and final top-`limit` overlap of 99%), the route ships switched off and the negative result is recorded with its numbers; no constant is tuned to pass. [paraphrase] [inferred] [strategy:Trustworthy retrieval and evidence]
- **R2:** Activated partitions with dimensions divisible by 8 maintain `vec_v2_<partitionId>` (`collection TEXT PARTITION KEY`, `coarse bit[dims]`) with `vector_partition_rows` and `vector_mirror_v2_state`, built in SQL from `vector_variants` and `vector_owners` during `gno embed`, `gno vec sync` and `gno vec rebuild`, with zero re-embedding. `vec_v1_*` is unchanged. Errors: missing sqlite-vec degrades to exact search; document sync on a connection without sqlite-vec succeeds; raw SQL and older-binary writes to `vector_variants` or `vector_owners` remove the clean mark through triggers that touch no `vec0` table; failed writes roll back without leaving the mapping table and the mirror diverged; partition re-key and drop leave no orphaned v2 table, mapping rows or state row. [paraphrase] [strategy:Local knowledge lifecycle]
- **R3:** The router sends every filtered search, every scope within the exact-cost budget, every query with `k` above 40, and every search on a missing, dirty, unchecked or null-cosine mirror to the exact paths, where output is identical to v2.16.0 across unscoped, collection-scoped, multi-collection, filtered, multi-owner and stale-owner parity tests. All other searches take the two-stage route. Errors: no search uses `rowid IN`; a batch of `Q` queries is routed as one unit; a search on a read-only connection never writes. [inferred] [strategy:Trustworthy retrieval and evidence]
- **R4:** Two-stage results carry exact float32 scores, exact `minScore` cutoffs and proven owners, sorted by `(distance, mirrorHash, seq, variantId)`, and `documentIds` never contains a document outside the requested collections, including for variants shared with other collections. Errors: underfilled results rerun on the exact path; `coarseK` never exceeds 500; a multi-collection search whose candidates would exceed 2000 runs exact. [inferred] [strategy:Trustworthy retrieval and evidence]
- **R5:** `gno vec sync`, `gno vec rebuild` and the end of a `gno embed` run perform the recall self-check on partitions above the budget whose check is absent, in one streaming pass over `vector_variants`, and store its result. The two-stage route is used only when stored recall is at least 0.95. An index built only by `gno embed` reaches the two-stage route without a manual sync, and an upgraded index with a clean `vec_v1` and a missing `vec_v2` gets its mirror built by the next `gno embed`. Errors: a partition whose check is absent or below the floor stays exact and `gno doctor` says why; the check never loads an embedding model. [inferred] [strategy:Trustworthy retrieval and evidence]
- **R6:** Same-collection `gno similar` (CLI, MCP and REST) scopes its vector search to the source document's collection, so another collection cannot crowd out the candidates, while `--cross-collection` stays unscoped. Errors: a source document without embeddings and inactive documents return the existing validation and empty responses on all three surfaces. [inferred] [strategy:Coherent agent and application surfaces]
- **R7:** `--explain` and the retrieval trace report the vector route, `N` and `coarseK`; one config switch disables coarse search; `gno status` and `gno doctor` report v2 mirror state and stored recall. Errors: JSON, MCP and REST outputs are unchanged when `--explain` is absent, and their schemas and contract tests are updated with the new fields. [inferred]
- **R8:** `bun run eval:memory` and `bun run eval:sessions` pass at 100% and `bun run eval:hybrid` stays within the R1 floor. On a 1.34M × 1024-dimension single collection the vector stage is at most 350 ms warm and 500 ms cold for `k = 10`, and at most 800 ms warm for `k = 40` (stage 1 plus stage 2, median of at least three runs), and a four-query batch on a 450k collection is at most 900 ms warm. Scopes within the budget show no latency regression against Spec 1. Errors: any gate failure blocks shipping the route as default. [paraphrase] [inferred]

## Boundaries
<!-- scope: business -->

- No float32 `vec0` mirror partitioned by collection. The exact scan is within about 25% of it. [inferred]
- No `rowid IN` filtering and no mirror use for filtered searches. [inferred]
- No `int8` mirror. It is no faster than float32. [inferred]
- No dropping of `vec_v1_*` or of float32 vectors in `vector_variants`. Dropping `vec_v1_*` would halve vector storage and is a follow-up once the exact scan is measured on a vacuumed real index. [inferred]
- No approximate post-filtering of coarse candidates for broad filters. Filtered search stays exact and eligibility-first. [inferred]
- No ANN index (HNSW, IVF, DiskANN) and no new runtime dependency beyond `sqlite-vec 0.1.9`. [paraphrase]
- No re-embedding and no change to embedding models, chunking, fusion or reranking. [paraphrase]
- No mirror build during read-only search commands. [inferred]
- No `page_size` change. [inferred]

## Decision Context
<!-- scope: both -->

Spec 2 of a two-spec vector scaling series. It depends on Spec 1 (`Lossless vector search hot fixes and DB hygiene`) and merges the earlier Spec 2 and Spec 3.

The first design moved collection-scoped searches onto a float32 `vec0` mirror partitioned by collection and added quantized search for larger scopes. The spike removed the first half. The exact SQL scan is already proportional to the collection, and at about 1.9 µs per vector it trails a float32 `vec0` scan by about 25%. The slow scoped searches seen on a long-lived large index (about 8 µs per vector) are a property of that file, which Spec 1 measures and addresses with `VACUUM INTO`.

We chose a `bit`-only mirror next to the untouched `vec_v1_*` over a merged float32 plus `bit` table. Both cost about 11.1 GB at 1.34M. The `bit`-only mirror builds in 2.6 s against 86.7 s at 500k, costs 0.135 MB per collection against 4.14 MB, and leaves older binaries their mirror. We rejected `int8` (float32 speed at seven times the size of `bit`), `rowid IN` (no scan saving, 32-bit comparison), and a `coarseK` above 500 (float32 cost).

We deferred real ANN and a multi-threaded flat mmap slab. Both add a second vector engine, and the two-stage path covers scopes up to the low millions.

## Parked unknowns

- **Recall at scale and on other models:** the spike measured one 1024-dimension model at 46.8k vectors with 25 queries. R1 measures at 500k or more, and the self-check guards each index.
- **Oversample for `k` from 21 to 40:** the 500 cap gives 12.5× at `k = 40`. R1 decides whether `maxCoarseQueryK` stays at 40 or drops to 20.
- **Cost coefficients on a fragmented index:** the budget formula comes from freshly built files. Spec 1's vacuum measurement shows whether it needs a per-index calibration.
