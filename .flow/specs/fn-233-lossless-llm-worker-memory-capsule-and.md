# Lossless LLM worker, memory, capsule, and session speed

## Conversation Evidence

> user (turn 1): "This is gno, my amazing product. I want you to go through all and find potential performance gains at no loss in quality"
> user (turn 3, selected): "(Recommended) split-as-proposed (5 independent-outcome no-plan specs; Spec 2 depends on Spec 1; stat-cache excluded for fn-117)"

## Goal & Context
<!-- scope: business -->
<!-- Source: 20% user / 15% [paraphrase] / 65% [inferred] -->

Eliminate IPC serialization/validation waste, repeated native llama.cpp context allocation, redundant tokenization, serial embed/HTTP loops, and quadratic/N+1 overhead across GNO's LLM worker, embedding runner, sessions ingestion, managed memory recall, Context Capsule compilation/verification, and core/publish utilities with zero loss in model outputs, embeddings, scores, or verification guarantees. Local inspection shows a single 32-chunk `embedBatch` currently runs `encodeNativeMessage` 5 times, validates every float through Zod 3 times (75k-150k checks), and executes 160 SQLite `isCurrent()` JOINs + 160 SHA-256 hashes in `variant-retry`; meanwhile `NodeLlamaCppGeneration` destroys and recreates its native `LlamaContext` and recompiles GBNF grammars on every call, and `NodeLlamaCppRerank` tokenizes every candidate pair 10x while tearing down its context on minor bucket jitter. [strategy:Trustworthy retrieval and evidence]

## Architecture & Data Models
<!-- scope: technical -->

1. **Native worker IPC & cold-start latency:**
   - Encode outgoing IPC requests once and pass `knownByteLength` from `NativeFrameDecoder` into request/response parsers so decoded payloads are never re-stringified solely to recheck `NATIVE_LOGICAL_BYTES`.
   - Replace triple Zod float-array validation on `embed`/`embedBatch` responses with one tight `Number.isFinite` + dimension loop in `parseNativeResponse` (removing redundant re-validation in `NativeEmbeddingPort`).
   - Add an O(N) char-length fast path in `splitEmbeddingRequest`, zero-copy single-frame decoding in `NativeFrameDecoder`, and module-level `TextEncoder`/`TextDecoder` singletons.
   - Support a binary `Float64Array` frame payload tag for `embed`/`embedBatch` `ok: true` responses (2.5x smaller than JSON, zero float-to-ASCII parsing, IEEE-754 double bit-exact).
   - Remove top-level static `import { getModuleVersion } from "node-llama-cpp"` + top-level `await` in `rerank-capacity` (and lazy-read `node-llama-cpp/package.json` in `embedding-identity`), hash GGUFs with a reusable 4 MB `fh.read` buffer instead of 16 KB WebStream chunks, overlap `manager.getLlama()` backend init with `fingerprintModel()` (still never starting `loadModel` until mutation verification passes), and drop redundant `file.exists()` before `stat()`.
2. **Embedding throughput, pipelining & HTTP transport:**
   - In `variant-retry`, add a BLOB-free `store.hasReusable(owner)` check, fold pre-write `isCurrent` and `store.write`'s validation into one atomic `store.writeCurrent(rows)`, and recheck `isCurrent` post-inference only for failed `retryOwners`. In legacy `retry`, cache already-formatted texts and reuse prepared queries.
   - Double-buffer foreground native embedding pages so SQLite commit of page `k-1` + prefetch/format of page `k+1` overlaps with child-worker inference of page `k` (tracking in-flight `inputHash`es across adjacent pages), and allow bounded concurrent in-flight batches (2-4) for `HttpEmbedding`.
   - In `NodeLlamaCppEmbedding`, schedule multi-context CPU batches in descending token-length order (LPT, writing results back to original indices) to eliminate tail-straggler idle time, overlap JS tokenization of chunk `i+1` with native eval of chunk `i` on single-context/GPU runs, and raise foreground default `batchSize` to 64-128 (keeping background capped at 32).
   - Make `HttpEmbedding.init()` idempotent once `this.dims !== null`, merge `classifyHttpDestination` + `prepareHttpDestination` (3 -> 2 DNS lookups while keeping `acquireConnection`'s DNS-rebinding recheck), and cache parsed `URL`/egress policy per HTTP port instance.
   - In model cache, lockfile, and registry: open directly in `validateGgufFile` (removing double `stat()` at 5 call sites), check `parseModelUri` before reading `manifest.json` for `file:` URIs, cache read-only manifest by `(mtimeMs, size)`, cache `hostname()`/`userInfo()` and use capped exponential backoff (15 ms -> 500 ms) in `lockfile`, cache `modelConfig`/`activePreset` on `LlmAdapter`, and fast-path empty-options `assertInferenceActive()`.
3. **Native generation & rerank context reuse:**
   - Retain and reuse a serialized `LlamaContext` + `LlamaContextSequence` on `NodeLlamaCppGeneration` (calling `await sequence.clearHistory()` before each session so KV state starts empty at position 0, shrinking when `this.contextSize > Math.max(4096, needed * 2)` to preserve VRAM limits, and releasing on error/model-change/dispose). Cache compiled `LlamaJsonSchemaGrammar` by `(llama, JSON.stringify(schema))` and cache the `LlamaChatSession` import.
   - In `NodeLlamaCppRerank`, deduplicate identical `documents` before neural scoring and switch `rankAndSort` to `rankAll` (removing multi-KB string `indexMap`); cache static `(prefix, middle, suffix)` template tokens per model and tokenize `query` once per batch; replace strict `this.contextSize !== contextSize` with bounded reuse hysteresis (`this.contextSize >= contextSize && this.contextSize <= Math.max(2048, contextSize * 2)`); on `gpu === false && cpuMathCores >= 12`, pool 2 `LlamaRankingContext`s at `threads: 6` with LPT scheduling.
4. **Sessions, managed memory, Context Capsules & core/publish utilities:**
   - Sessions: reuse one sanitizer/policy across units, check unchanged unit fingerprints before sanitizing locators, batch `unitFingerprint` `stat` calls with bounded concurrency, skip pass-2 `drafts` array allocation when `detectedValues.length === 0`, and combine fixed-prefix secret rules in `ThreadSanitizer` into a fast-reject prefilter so clean turns skip 9 extra regex scans.
   - Memory recall: pass `memoryFilter: { scopes, excludeSuperseded: true }` directly into `searchVectorWithEmbedding` (removing full `listMemoryEligibleDocuments` fetch + `allowedMirrorHashes`), overlap `embedPort.embed(query)` with lexical search, batch `readFact` via `getContentBatch`, and precompute per-fact `(bytes, tokens)` using `Buffer.byteLength` in `selectWithinBudget` (O(K) instead of O(K^2)).
   - Context Capsules: in `compileContextEvidence`, skip the second full `captureContextEvidenceSnapshot` when SQLite's `(PRAGMA data_version, total_changes(), contextGeneration)` did not change between `before` and `after` (falling back to full capture if any write occurred); pre-index `documents` by `uri`/`docid` in `context-verifier` and `context-evidence` (eliminating O(E x D) scans and repeated `deriveDocid` SHA-256) and memoize `sha256Text(content)` per `mirrorHash`; run multi-collection `deps.retrieve` calls concurrently in `context-compiler`.
   - Core & publish micro-wins: remove the redundant `[...scores.entries()].sort(...)` inside `analyzeGraphCommunities`'s inner loop (the tie-break is order-independent), short-circuit `truncateText` when `text.length <= maxGraphemes`, cache `resolveLockCommand()` once per process in `file-lock`, replace pure-JS PNG CRC32 with `Bun.hash.crc32`, and replace `atob` + loop in `encrypted-export` with `Buffer.from(value, "base64")`.

## API Contracts
<!-- scope: technical -->

- Native worker IPC remains internal; framing stays backward-compatible within the matched parent/child binary pair and preserves all protocol error codes (`protocol`, `oversized`, `stale_generation`, `duplicate_completion`, `overloaded`).
- `EmbeddingPort`, `GenerationPort`, `RerankPort`, `MemoryService`, `SessionsService`, `ContextCompiler`, `ContextVerifier`, and `PublishExportService` keep exact public input/output schemas and error semantics.

## Edge Cases & Constraints
<!-- scope: technical -->

- **Bit-exact LLM & embedding parity:** LPT scheduling, binary `Float64Array` framing, `rankAll` deduplication, dual-context CPU rerank (`threads: 6` per context), and `sequence.clearHistory()` must maintain exact parity with existing native rerank/embedding parity and protocol tests.
- **Model mutation security boundary:** Overlapping `getLlama()` with `fingerprintModel()` must never start `loadModel()` or `port.init()` if the GGUF artifact mutates during hashing.
- **DNS rebinding protection:** Merging `classifyHttpDestination` + `prepareHttpDestination` must keep `acquireConnection()`'s independent pre-connect DNS rebinding check intact (updating any test asserting `3` resolver calls to `2` with explicit justification).
- **Capsule drift integrity:** Skipping the post-compile full snapshot is valid strictly when the store proves zero commits and zero context mutations occurred during compilation; custom non-SQLite stores always run the full post-compile snapshot.
- **Lockfile crash safety:** Preserve `fh.sync()` in `createLockExclusive` so crashes cannot leave 0-byte lockfiles.

## Acceptance Criteria
<!-- scope: both -->

- **R1:** Native worker IPC encodes requests once, avoids post-decode re-encoding, validates float arrays in one finite/dimension loop, fast-paths `splitEmbeddingRequest`, decodes single frames zero-copy, and transports `embed`/`embedBatch` vectors in binary `Float64Array` frames; worker startup loads `node-llama-cpp` version lazily, hashes GGUFs with a 4 MB buffer, and overlaps `getLlama()` with `fingerprintModel()`. Errors: oversized frames, non-finite floats, mismatched vector lengths, stale generations, and mutated model files fail closed with identical protocol/security errors. [inferred]
- **R2:** `variant-retry` avoids BLOB decodes for reusability checks and validates once atomically inside `store.writeCurrent(rows)`; foreground native embedding overlaps DB commit/prefetch with worker inference; `HttpEmbedding` supports bounded concurrent batches and idempotent `init()`; `NodeLlamaCppEmbedding` uses LPT scheduling on multi-context CPU and overlapped tokenization on single-context/GPU; HTTP inference merges destination classify+prepare (2 DNS lookups total); model cache/lockfile/registry eliminate double `stat()`s, `file:` manifest reads, and redundant config merges. Errors: contention retries, batch fallback recovery, DNS-rebinding rejections, egress denials, and corrupt GGUFs behave identically. [inferred]
- **R3:** `NodeLlamaCppGeneration` reuses a bounded `LlamaContext` (reset via `clearHistory()`) and caches compiled `LlamaJsonSchemaGrammar` instances; `NodeLlamaCppRerank` deduplicates documents, uses `rankAll`, caches template/query tokens, applies bounded context-size hysteresis (shrinking after large spikes), and uses a 2-context pool on >=12-core CPU-only hosts. Errors: disposed contexts, oversized rerank inputs, and aborts release/recreate contexts cleanly with exact parity against native rerank/generation tests. [inferred]
- **R4:** Sessions import reuses sanitizers across units, fingerprints units with bounded concurrency, skips pass-2 draft mapping when zero secrets were detected, and uses a fast-reject regex prefilter in `ThreadSanitizer`. Errors: all secret patterns, cross-turn propagation, malformed/truncated lines, and `bun run eval:sessions` (100% gate) remain bit-identical. [inferred]
- **R5:** Managed memory recall uses native `memoryFilter` on the vector leg, overlaps query embedding with lexical search, batches `readFact` via `getContentBatch`, and computes budget projections in O(K) with `Buffer.byteLength`. Errors: scope/supersession isolation, empty/over-budget hints, and `bun run eval:memory` (100% gate) remain identical. [inferred]
- **R6:** Context Capsule compilation skips redundant post-compile full snapshots when SQLite proves zero mutations occurred, `context-verifier` and `context-evidence` index documents via `Map` and memoize `sha256Text(content)` per `mirrorHash`, `context-compiler` retrieves multiple collections concurrently, and core/publish helpers remove `analyzeGraphCommunities`'s redundant inner sort, short-circuit `truncateText`, cache `file-lock` command resolution, use `Bun.hash.crc32`, and use `Buffer.from(..., "base64")`. Errors: concurrent index/context drift during compile still throws `index_changed_during_compile` / `context_changed_during_compile`, and all capsule, graph, lock, and publish tests pass identically. [inferred]

## Boundaries
<!-- scope: business -->

- No model changes, quantization changes, prompt-prefix KV reuse that could alter floating-point GEMM outputs, or relaxation of DNS-rebinding / model-fingerprint / redaction security invariants.
- No SQLite PRAGMAs or schema migrations (Spec 1), retrieval pipeline orchestration (Spec 2), ingestion/converters (Spec 3), or CLI/serve/UI/MCP changes (Spec 4).

## Decision Context
<!-- scope: both -->

Part of a 5-spec lossless performance series from the v2.15.0 full-codebase performance audit (independent of Specs 1, 2, 3, and 4). Bundling the native LLM worker, embedding loop, sessions, memory, Context Capsule, and publish wins together keeps every runtime-inference and core-service hot path covered with strictly lossless, contract-verified optimizations. [paraphrase]
