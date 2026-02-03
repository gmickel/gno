# fn-29-fix-embedbatch-to-use-native-batch-api.1 Update embedBatch to use getEmbeddingsFor

## Description

TBD

## Acceptance

- [ ] TBD

## Done summary

## Summary

Fixed `embedBatch()` in `NodeLlamaCppEmbedding` to use safe concurrent processing:

1. **Bounded concurrency**: Added `MAX_CONCURRENT_EMBEDDINGS=16` constant to process batches in chunks
2. **Dispose safety**: Use `Promise.allSettled` per chunk so all in-flight ops complete before returning
3. **LlmResult contract**: Wrapped in try/catch to ensure no throws leak to callers
4. **Order preservation**: Sequential chunk processing with `allResults.push(...chunkResults)`

Note: node-llama-cpp v3.x lacks a native batch API (`getEmbeddingsFor`), so we must call `getEmbeddingFor` individually. The implementation provides parallelism within bounds while avoiding the original issues (sequential loop was O(n) slow, unbounded Promise.all was unsafe).

## Files changed

- `src/llm/nodeLlamaCpp/embedding.ts`

## Tests

- All 1338 tests pass
- Lint clean

## Evidence

- Commits:
- Tests:
- PRs:
