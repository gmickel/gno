---
satisfies: [R1, R2, R3, R4, R5, R6, R7]
---
# fn-230-lossless-retrieval-and-verification.1 Implement Lossless retrieval and verification pipeline performance

## Description
TBD

## Acceptance
- [ ] TBD

## Done summary
### Summary

Implemented lossless retrieval and verification pipeline optimizations (`R1`–`R7`) for `fn-230-lossless-retrieval-and-verification`:

- **R1 (Deduplicated BM25 & fail-fast):** `src/pipeline/hybrid.ts` executes the original query's FTS5 search once before expansion, fails fast on `INVALID_INPUT` before calling `expandPort`, computes `hasStrongSignal` from the top 5 rows, and reuses the original FTS outcome (success or `QUERY_FAILED`) whenever an expansion lexical variant matches `query.trim()`.
- **R2 (Clean-mirror `vec0` fast path & batched variant search):** `src/store/vector/variant-search.ts`, `src/store/vector/proof-cache.ts`, `src/store/vector/sqlite-vec.ts`, `src/store/vector/lazy.ts`, `src/store/vector/types.ts` add the clean-mirror `vec0` fast path (guarded by mirror existence, `dirty = 0`, non-zero query/stored vectors, boundary distance proof, with seamless fallback to `vector_variants` when dirty, absent, or tied/unproven at the boundary) and `searchNearestBatch` single-pass multi-query scanning. `hybrid.ts` deduplicates identical formatted query strings before embedding/search and falls back per unique embedding on batch error. Benchmark (`5000 x 768d`): unscoped `3.0 ms` p50 (down from `14.86 ms`), collection-filtered `1.0 ms` p50, metadata-filtered `1.0 ms` p50.
- **R3 (Deterministic `llm_cache` expansion cache):** Added optional `getLlmCache`/`setLlmCache` on `StorePort` / `SqliteAdapter` (expiry-aware, silent no-op on read-only/busy locks), exposed `modelPath`/`modelFingerprint` through `GenerationPort`, `NativeGenerationPort`, `NodeLlamaCppGeneration`, and `lazyGenerationPort`, strictly validated persisted cache payloads, validated pre-generation model fingerprints against bound canonical paths (preventing cold-generation races and symlink-retargeting collisions), and wired `expandQueryCached` in `hybrid.ts` with `expansionCacheLookups`/`expansionCacheHits` counters.
- **R4 (Per-request hydration & owner fusion):** `src/pipeline/hydration.ts` caches `getDocumentsByMirrorHashes` per `(scopeKey, mirrorHash)` (merged sorted by `id ASC`), skips deep clone/freeze on string primitives, and shallow-freezes `ChunkRow` snapshots. `src/pipeline/owner-fusion.ts` batches tags via `getTagsBatch`, parallelizes fetches, and resolves only `[graphInput]` on the post-graph pass without double-counting graph RRF weight.
- **R5 (Concurrent retrieval, deferred hydration, paginated graph):** `hybrid.ts` runs lexical variants concurrently with the vector leg via `Promise.allSettled`, uses `getChunksBySequenceBatch` when `!intent && !exclude`, and recovers per-hash on `--full` `getContentBatch` error. `search.ts` defers default-mode chunk/snippet/hash work until after `.slice(0, limit)` (with seq-0 fallback for title-only matches) and defers `--full` content fetches restoring original `chunk.startLine`. `vsearch.ts` eliminates throwaway first-pass `SearchResult` construction and defers `--full` fetches. `answer.ts` batches `getContentBatch` with per-hash recovery. `graph-retrieval.ts` paginates neighbor hydration in ranked pages stopping once `maxCandidates` survive.
- **R6 (Single-pass claim verification & O(J) judgment indexing):** Split `prepareClaimVerification` and `applySemanticJudgments` in `src/pipeline/claim-verification.ts` (reused by `claim-verifier.ts`), removed redundant capsule re-parsing, indexed `semanticJudgments` into a `Map` in O(J), added quote-delimiter fast-skip + memoized evidence normalization, used single-pass `CITATION_PATTERN` with two-pointer sweep and boundary-crossing local claim re-scan, and switched prompt size check to `Buffer.byteLength`.
- **R7 (Inner-loop cleanups):** Pre-grouped `egress-lineage.ts`, compiled document filters (`filters.ts`, `temporal.ts`, `exclude.ts`), Map-indexed `rerank.ts`, single-chunk fast return & hoisted terms in `intent.ts`, frontmatter fast-skip in `snippet.ts`, guarded auxiliary scoring & language-detection skip in `hybrid.ts`/`search.ts`/`vsearch.ts`, precomputed `recencySort` timestamps, deferred `passageHash`, and `indexOf("\n")` slicing in `answer.ts`.

### Verification

- `bun test test/pipeline/retrieval-verification-performance.test.ts` (23/23 pass)
- `bun test test/pipeline/ test/store/ test/embed/variant-backlog-scope.test.ts test/audit/ test/sdk/ test/cli/ test/mcp/ test/llm/` (all passing)
- `bun run typecheck` (0 errors)
- `oxlint --type-aware --type-check` on all changed files (0 warnings, 0 errors)
- `bun run eval:memory` (100% — 114/114 evals)
- `bun run eval:sessions` (100% — 35/35 evals)
- `bun run bench:vector-search -- --chunks 5000 --dims 768` (unscoped 3.0ms p50, collection 1.0ms p50, metadata 1.0ms p50)
- Codex `impl-review` (`codex:gpt-6.2-sol:medium`): 5 rounds -> `SHIP` (0 introduced, 0 pre-existing)

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 55748993ac221934e4fd450e125456e7ea0771ef, a2986faa355fdf3d20ad8425281075eca1b7a4e7, 3ccf42e95ba7edf7384abb1b4d82e3d53c393509, aae882af4a22df178aea0d3f5fb15ca45bee830b, 622c8f5ea92dfb095a0076974e1c2ffbc859d256
- Tests: bun test test/pipeline/retrieval-verification-performance.test.ts, bun test test/pipeline/ test/store/ test/llm/, bun run typecheck, bun run eval:memory, bun run eval:sessions
- PRs: