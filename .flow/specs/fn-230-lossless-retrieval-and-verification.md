# Lossless retrieval and verification pipeline performance

## Conversation Evidence

> user (turn 1): "This is gno, my amazing product. I want you to go through all and find potential performance gains at no loss in quality"
> user (turn 3, selected): "(Recommended) split-as-proposed (5 independent-outcome no-plan specs; Spec 2 depends on Spec 1; stat-cache excluded for fn-117)"
> user (turn 3, selected): "(Recommended) Wire existing llm_cache table for deterministic expandQueryCached in Spec 2 (saves 1-20s on repeated queries; adds StorePort cache methods)"

## Goal & Context
<!-- scope: business -->
<!-- Source: 25% user / 20% [paraphrase] / 55% [inferred] -->

Cut end-to-end latency across BM25, vector, hybrid, graph-expanded, grounded-answer, and claim-verified retrieval with zero loss in retrieval rankings, recall, precision, or verification integrity. The retrieval pipeline currently repeats identical FTS5 queries up to 3 times, executes 4-5 separate vector scans during expanded hybrid search, misses its own per-request document hydration cache on every stage, triggers N+1 tag and full-content reads, leaves the existing `llm_cache` table unwired for deterministic query expansion, and parses Context Capsules up to 6 times with O(claims x judgments) Zod validation during claim verification. [strategy:Trustworthy retrieval and evidence]

## Architecture & Data Models
<!-- scope: technical -->

1. **Deduplicated BM25 and concurrent retrieval legs:**
   - Run the original query's FTS5 search once before the expansion strength check (`limit: Math.max(5, limit * 2 * retrievalMultiplier)`), fail fast on `INVALID_INPUT` before invoking LLM query expansion, compute `hasStrongSignal` from the top 5 rows, and reuse the sliced original results whenever an expansion lexical variant matches `query.trim()`.
   - Run lexical expansion variants concurrently with the out-of-process vector embedding/search leg via `Promise.all`, appending to `rankedInputs`, `diagnoseTrace`, `explainLines`, and `counters` in the exact existing deterministic order.
   - Deduplicate identical formatted query strings in expanded vector batches before embedding and before `searchNearest`, reusing the max-limit results and slicing per variant while preserving every RRF input contribution.
2. **Clean-mirror `vec0` fast path and single-pass multi-query vector search (builds on Spec 1):**
   - When `vector_mirror_state` marks the active partition clean (`dirty = 0`) and no eligibility filters are active, query `vec_v1_<partition>` directly (`MATCH ? AND k = ?`) and prove/resolve owners for returned `variant_id`s, checking distance ties at the k-th boundary and falling back to `vector_variants` if unproven/inactive owners exhaust the batch (measured `3.24 ms` vs `14.86 ms` default for 1 query, `12.81 ms` vs `58.76 ms` for 4 expanded queries on 5,000 x 768d chunks).
   - Add an optional batched vector search method (`searchNearestBatch`) so filtered multi-query hybrid searches scan eligible `vector_variants` once for all expanded query vectors instead of 4-5 separate scans (measured `16.09 ms` vs `36.98 ms` tuned / `58.76 ms` default for 4 queries).
3. **Deterministic expansion cache (`llm_cache`):**
   - Expose optional `getLlmCache(key)` / `setLlmCache(key, value)` methods on `StorePort` backed by the existing `llm_cache` table in SQLite.
   - Include `contextSize` and the effective expansion model fingerprint (or URI + cached file mtime/size) in `generateCacheKey`, wire `expandQueryCached` in hybrid search when the store supports it, pass cached entries through `applyExpansionGuardrails`, and record `expansionCacheLookups` / `expansionCacheHits`.
4. **Per-request hydration and owner fusion:**
   - Cache `RequestHydration.getDocumentsByMirrorHashes` per `(scopeKey, mirrorHash)` (sorting merged rows by `id ASC` to match store ordering when within the 898-hash batch bound) so `owner-fusion`, `graph-retrieval`, and `hybrid` assembly share cached rows instead of re-querying 3-5 times.
   - Skip `structuredClone` and `freezeDeep` on immutable string primitives in `RequestHydration`, and shallow-copy + `Object.freeze` flat `ChunkRow` objects instead of deep cloning.
   - In `resolveFusionOwners`, batch tag checks via `store.getTagsBatch`, parallelize independent fetches (`getDocumentsByMirrorHashes`, `getChunksBatch`, per-collection `listMemoryEligibleDocuments`), and on the post-graph pass resolve owners only for the new `[graphInput]` instead of re-resolving all `rankedInputs`.
5. **Scoped chunk loading, deferred `--full` content fetches, and paginated graph hydration:**
   - Use `store.getChunksBySequenceBatch` in `hybrid` assembly when `!intent && !exclude`.
   - In BM25 default mode (`!full && !lineNumbers && !intent && !exclude`), defer chunk loading, `cleanDisplaySnippet`, and `passageHash` until after `.slice(0, limit)` so `attachChunkSnippets` does not duplicate and overwrite work on discarded candidates.
   - Replace N+1 `getContent` loops in `hybrid` (`--full`) and `answer` with `getContentBatch`; in BM25 and vector `--full` paths, filter, sort, and `.slice(0, limit)` before calling `getContentBatch`, removing throwaway first-pass `SearchResult` construction in vector search.
   - Paginate `graph-retrieval` neighbor hydration in ranked pages (`maxCandidates * 3`) stopping as soon as `maxCandidates` survive metadata and tag filters, and use `getChunksBySequenceBatch` when `!options.lang`.
6. **Claim verification single-pass and O(J) judgment indexing:**
   - Remove redundant `contextCapsuleV1Schema.parse(capsule)` after `parseContextCapsuleV1`; split deterministic preparation from judgment application so `claim-verifier` parses the capsule, freshness, claims, citations, and quotes once instead of twice.
   - Pre-parse `semanticJudgments` once into a `Map` keyed by `claimId` (O(J) instead of O(C x J) up to 65,536 Zod parses).
   - Check whether a claim contains quotes before normalizing evidence passages (and memoize `normalizeQuoted` per `evidenceId`); scan `CITATION_PATTERN` once with a two-pointer sweep over sorted claims; use `Buffer.byteLength(prompt, "utf8")` for prompt size checks.
7. **Inner-loop filter, rerank, snippet, lineage, and answer cleanups:**
   - Pre-group `ownershipDocuments` and `results` by `mirrorHash` in `attachSearchResultEgressLineage` and pass only `finalResults` hashes.
   - Compile query-invariant document filters once per search (`Set`s, lowercased author/categories/excludes, pre-parsed `sinceMs`/`untilMs`), early-return `true` in `isWithinTemporalRange` when neither bound is set, lowercase each chunk once in `exclude`, and eliminate duplicate filtering in `hybrid`.
   - Replace O(N^2) `toRerank.find` in `rerank` with a Map; hoist `extractSteeringTerms` per query, fast-return single-chunk docs, and lowercase each chunk once in `intent`.
   - Fast-skip `proseAfterEmbeddedFrontmatterFence` when `!text.includes("-")` and skip its duplicate call in `isFrontmatterDominatedSnippet`; guard auxiliary scoring in `hybrid` with `if (auxiliaryRankingActive)`; skip `detectQueryLanguage` (`franc`) when `--lang` or `queryLanguageHint` is provided; precompute `recencySort` timestamps; defer `passageHash` until after `.slice(0, limit)`; use `indexOf("\n")` slicing and verified `passageHash` reuse in `answer`.

## API Contracts
<!-- scope: technical -->

- `StorePort` gains optional `getLlmCache?(key: string): Promise<StoreResult<string | null>>` and `setLlmCache?(key: string, value: string): Promise<StoreResult<void>>`. Custom or mock `StorePort` implementations that omit these methods fall back transparently to uncached expansion.
- `VectorIndexPort` may expose optional `searchNearestBatch?(embeddings: Float32Array[], limits: number[], options?: VectorSearchOptions): Promise<StoreResult<VectorSearchResult[][]>>`; callers fall back to `searchNearest` when absent.
- All CLI, REST, MCP, SDK, `SearchResults`, `ExplainLine`, `QueryDiagnoseTrace`, and `ClaimVerificationResult` shapes remain unchanged (with `expansionCacheLookups` and `expansionCacheHits` now reflecting real hits).

## Edge Cases & Constraints
<!-- scope: technical -->

- **Exact tie parity on `vec0` fast path:** When `vec_v1_<partition>` returns `k` hits and unproven/inactive owners or equal distances at the k-th rank exist, the implementation must over-fetch or fall back to `vector_variants` so the returned top-k and tie-break order (`distance, mirrorHash, seq, variantId`) match `vector_variants` bit-for-bit.
- **Expansion cache invalidation:** Cache keys must incorporate prompt version, `modelUri`, effective model file fingerprint (or mtime/size when local), `contextSize`, `query`, `lang`, and `intent`, and ignore corrupt/unparseable cache rows gracefully by falling back to live expansion.
- **Read-only store connections:** `setLlmCache` must silently no-op (never fail a search) when the store is opened read-only or when a `SQLITE_BUSY` write lock occurs.
- **Aborts and inference scope:** Concurrent lexical/vector execution must preserve `assertInferenceActive()` and `AbortSignal` propagation without leaving unhandled rejections.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** Hybrid search executes the original query's FTS5 query once, fails fast on FTS `INVALID_INPUT` before calling `expandQuery`, computes `hasStrongSignal` from the top 5 rows, and reuses sliced original results for any expansion lexical variant matching `query.trim()`. Errors: malformed FTS queries return `INVALID_INPUT` immediately without invoking `expandPort`. [inferred]
- **R2:** Unscoped variant vector search uses `vec_v1_<partition>` when `vector_mirror_state` marks the partition clean (`dirty = 0`), falling back cleanly when dirty, filtered, or unproven/tied at the boundary; multi-query expanded hybrid vector searches execute a single batched scan (`searchNearestBatch`) when supported and deduplicate identical formatted query strings. Errors: dirty mirrors, missing `vec0` tables, or tie/unproven boundary cases fall back seamlessly with bit-identical results and tie-breaks. [inferred]
- **R3:** Hybrid search wires `expandQueryCached` through optional `StorePort` `getLlmCache`/`setLlmCache` backed by `llm_cache`, including `contextSize` and model identity in the cache key and updating `expansionCacheLookups`/`expansionCacheHits`. Errors: corrupt cache entries, read-only stores, `SQLITE_BUSY` on cache write, or stores without cache methods never fail retrieval and fall back to live expansion. [paraphrase]
- **R4:** `RequestHydration` caches documents per `(scopeKey, mirrorHash)`, skips `structuredClone`/`freezeDeep` on primitives, shallow-freezes flat `ChunkRow`s, and `resolveFusionOwners` batches tags via `getTagsBatch` and resolves only new graph candidates on the second pass. Errors: store failures propagate identical `OwnerMetadataError` / `QUERY_FAILED` results; caller mutation of returned snapshots remains prevented. [inferred]
- **R5:** Lexical expansion variants and vector embedding/search run concurrently via `Promise.all` with deterministic post-join ordering; `hybrid` uses sequence-scoped chunk loading when `!intent && !exclude`; `search` defers default-mode chunk/snippet/hash work until after `.slice(0, limit)`; `--full` content fetches in `hybrid`, `search`, `vsearch`, and `answer` use `getContentBatch` on surviving results only; `graph-retrieval` paginates neighbor hydration in ranked order. Errors: abort signals, missing chunks/content, and filter rejections behave identically to current code. [inferred]
- **R6:** Claim verification parses each Context Capsule once, runs deterministic preparation once, pre-indexes `semanticJudgments` into a `Map` in O(J), normalizes evidence only for claims containing quotes (memoized per `evidenceId`), scans citations in a single two-pointer sweep, and uses `Buffer.byteLength`. Errors: malformed capsules, citation limit overflows, duplicate/mismatched judgments, and misquoted claims produce identical errors and verdicts. [inferred]
- **R7:** Egress lineage grouping, compiled document filters, `exclude`, `temporal`, `rerank`, `intent`, `snippet`, `content-type-boost`, `query-language` skip-on-explicit-lang, `recencySort` timestamps, deferred `passageHash`, and `answer` line slicing eliminate their quadratic scans and redundant allocations. Errors: no error surface beyond existing pipeline contracts; retrieval eval gates (`bun run eval:memory`, `bun run eval:sessions`, `bun run eval:hybrid` / retrieval tests) show zero quality regression. [inferred]

## Boundaries
<!-- scope: business -->

- No changes to RRF weights, blending schedules, rerank candidate limits, BM25 strong-signal thresholds, or prompt wording.
- No speculative/approximate ANN vector search; all vector results remain exact.
- No SQLite schema migrations or PRAGMA changes (owned by Spec 1).
- No native llama.cpp context reuse or IPC protocol changes (owned by Spec 5).

## Decision Context
<!-- scope: both -->

Part of a 5-spec lossless performance series from the v2.15.0 full-codebase performance audit (depends on Spec 1 `Lossless SQLite and vector store performance`; sibling independent specs cover ingestion/converters, CLI/serve/UI/MCP, and LLM worker/core/sessions).

The user explicitly chose to wire the already-present `llm_cache` table for `expandQueryCached` (with `contextSize` and model fingerprint in the cache key) to eliminate 1-20s redundant expansion latency on repeated queries while keeping greedy deterministic outputs identical. Depending on Spec 1 ensures `vec0` fast-path and batched variant scans leverage the new `vector_owners` covering indexes and epoch-keyed proof cache. [paraphrase]
