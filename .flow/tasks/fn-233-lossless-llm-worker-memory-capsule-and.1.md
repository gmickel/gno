---
satisfies: [R1, R2, R3, R4, R5, R6]
---
# fn-233-lossless-llm-worker-memory-capsule-and.1 Implement lossless LLM worker, embedding, sessions, memory, capsule, and core/publish optimizations

## Description
TBD

## Acceptance
- [ ] TBD

## Done summary
Implemented all lossless performance optimizations for fn-233 (R1-R6) across native worker IPC, embedding throughput/pipelining/HTTP transport, native generation & rerank context reuse, sessions ingestion, managed memory recall, Context Capsules, and core/publish utilities:

- **R1 (Native worker IPC & cold-start latency):** Single-encode outgoing requests with `knownByteLength`, single-pass finite/dimension float validation, O(N) char-length fast path in `splitEmbeddingRequest`, zero-copy single-frame decoding in `NativeFrameDecoder`, bit-exact binary `Float64Array` framing for `embed`/`embedBatch` `ok: true` responses (fail-closed on non-zero padding, NaN/Inf, truncation, and oversize), lazy `node-llama-cpp` package version loading, 4 MB GGUF hashing, and overlapped `getLlama()` + `fingerprintModel()` while preserving model-mutation verification before `loadModel()`.
- **R2 (Embedding throughput, pipelining & HTTP transport):** BLOB-free `hasReusable` / `findReusableHashes` and atomic `writeCurrent(rows)` in `VectorVariantStore`; cached formatting & prepared statements in legacy `retry`; foreground double-buffering with carried vectors across adjacent pages and bounded HTTP concurrency (3 in-flight batches with ref-counted shared vector eviction); LPT scheduling on multi-context CPU and macrotask-overlapped tokenization on single-context/GPU in `NodeLlamaCppEmbedding`; foreground default `batchSize` raised to 64 (background capped at 32); idempotent `HttpEmbedding.init()`, merged `prepareClassifiedHttpDestination` (3 -> 2 DNS lookups while preserving `acquireConnection()` DNS rebinding check) with live policy-mutation invalidation; direct `open` in `validateGgufFile`, `file:` URI fast path before manifest read, stat-cached read-only manifest, 4 MB `computeSha256`, cached hostname/username + capped exponential backoff (`15ms -> 500ms`, preserving `fh.sync()`) in `lockfile`, cached `modelConfig`/`activePreset` on `LlmAdapter`, and fast-path no-args `assertInferenceActive()`.
- **R3 (Native generation & rerank context reuse):** Serialized bounded `LlamaContext` + `LlamaContextSequence` reuse with `clearHistory()`, `session.dispose({ disposeSequence: false })`, exact match for explicit `params.contextSize`, LRU-bounded `LlamaJsonSchemaGrammar` cache, and cached `LlamaChatSession` import; rerank document deduplication, direct evaluation of audited pre-built `Token[]` pairs (caching static template tokens per model and tokenizing query/docs once per batch), bounded reuse hysteresis (`[needed, max(2048, needed * 2)]`), and 2-context CPU pooling (`threads: 6`) with LPT bin-packing on `gpu === false && cpuMathCores >= 12`.
- **R4 (Sessions ingestion):** Single reusable `ThreadSanitizer` across units/threads, bounded lookahead `unitFingerprint` windows with live-append re-verification and unchanged check before locator sanitization, zero-secret pass-2 `drafts` fast path, and combined fast-reject regex prefilter in `ThreadSanitizer`.
- **R5 (Managed memory recall):** Bounded `limit: 1` eligibility probe preserving empty-scope hybrid short-circuit, overlapped lexical search (immediately observed against unhandled rejections) + query embedding, native `memoryFilter` on vector leg, `getContentBatch` with per-hash fallback on failure, `Buffer.byteLength` in `utf8Bytes`, and O(K) incremental accepted-prefix budget tracking in `selectWithinBudget`.
- **R6 (Context Capsules & core/publish micro-wins):** Zero-mutation SQLite watermark (`PRAGMA data_version`, `total_changes()`, `contextGeneration`, same connection, `!inTransaction`) captured before `before` snapshot to skip redundant post-compile full snapshot while catching any mutation; `Map`-indexed documents + memoized `deriveDocid` & `sha256Text(content)` in `context-evidence`/`context-verifier`; concurrent multi-collection `deps.retrieve` in `context-compiler`; removed redundant inner sort in `analyzeGraphCommunities`, verified `truncateText` short-circuit, cached `resolveLockCommand()`, `Bun.hash.crc32` for PNG CRC32, and strict-validated `Buffer.from(..., "base64")` in `encrypted-export`.

Reviewed via 3 rounds of Codex `impl-review` (`codex:gpt-6.2-sol:medium`): round 1 3-lens fanout found 17 items (7 P1, 10 P2), round 2 found 2 items (1 P1, 1 P2), round 3 returned `VERDICT=SHIP` (0 findings). Verified via `bun run typecheck`, `bun run lint:check`, full test suite + dedicated `test/llm/fn233-worker-embed-memory-capsule-performance.test.ts` (19 tests), `bun run eval:memory` (100%), and `bun run eval:sessions` (100%).

stage: plan-sync - skipped(config: planSync.enabled != true)
## Evidence
- Commits: 918e5ba1, 714113e0, 36033d8d
- Tests: bun run typecheck, bun run lint:check, bun run test:tmp-check, bun test test/llm/ test/embed/ test/egress/ test/sessions/ test/core/memory*.test.ts test/core/context-*.test.ts test/core/graph-analysis.test.ts test/core/file-lock.test.ts test/publish/ test/store/vector/ test/store/sqlite/, bun run eval:memory, bun run eval:sessions
- PRs: