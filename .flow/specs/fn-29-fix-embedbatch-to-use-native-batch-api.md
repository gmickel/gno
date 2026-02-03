# Fix embedBatch to use actual batch API

## Problem

`NodeLlamaCppEmbedding.embedBatch()` in `src/llm/nodeLlamaCpp/embedding.ts` iterates sequentially:

```typescript
for (const text of texts) {
  const embedding = await ctx.value.getEmbeddingFor(text); // SEQUENTIAL
}
```

This defeats the purpose of batching. With batch size 32, we make 32 sequential calls instead of 1 batch call.

## Solution

Use node-llama-cpp's actual batch embedding API:

```typescript
// Instead of loop, use:
const embeddings = await ctx.value.getEmbeddingsFor(texts);
```

Or if the API differs, check node-llama-cpp docs for `LlamaEmbeddingContext` batch methods.

## Expected Impact

- Significant speedup (potentially 5-10x for local inference)
- Better GPU utilization (single kernel launch vs many)
- Reduced overhead from repeated context switches

## Tasks

1. Research node-llama-cpp batch embedding API
2. Update `embedBatch()` to use native batch call
3. Add/update tests for batch embedding
4. Benchmark before/after

## Acceptance Criteria

- [ ] `embedBatch()` uses single native call (not loop)
- [ ] Tests pass
- [ ] Measurable speedup in `gno embed` for 1000+ chunks
