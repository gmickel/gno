# Plan: vsearch N+1 Query Optimization

**Bead**: gno-o0u
**Type**: Performance optimization
**Depth**: STANDARD

## Overview

Per-hit `getChunks()` calls in vsearch.ts (and hybrid.ts, rerank.ts, search.ts) cause N+1 query patterns. Add batch method `getChunksBatch()` to StorePort, refactor pipelines to pre-fetch all chunks in single query.

## Scope

**In scope**:

- Add `getChunksBatch()` to StorePort interface
- Implement in SqliteAdapter with parameter-limit batching
- Refactor vsearch.ts, hybrid.ts, rerank.ts to use batch
- Update test mocks to implement new method
- Unit and integration tests

**Out of scope**:

- FTS search optimization (already uses efficient JOINs)
- `getContentBatch()` for --full mode (future work)
- Language filter push-down into batch query
- Alternative: enrich `VectorIndexPort.searchNearest` to include chunk text via JOIN (deferred)

## Approach

### 1. Add StorePort method

**File**: `src/store/types.ts` (around line 419)

```typescript
/**
 * Batch fetch chunks for multiple mirror hashes.
 * Returns Map where each ChunkRow[] is sorted by seq ascending.
 * Missing hashes are not present in the returned Map.
 * Note: Map is not JSON-serializable; internal pipeline optimization only.
 */
getChunksBatch(mirrorHashes: string[]): Promise<StoreResult<Map<string, ChunkRow[]>>>;
```

### 2. Implement in SqliteAdapter

**File**: `src/store/sqlite/adapter.ts`

```typescript
// Reserve headroom for future params (e.g., language filter); reduce if adding params
const SQLITE_MAX_PARAMS = 900;

async getChunksBatch(mirrorHashes: string[]): Promise<StoreResult<Map<string, ChunkRow[]>>> {
  // Early return for empty input
  if (mirrorHashes.length === 0) {
    return ok(new Map());
  }

  // Dedupe and filter empty strings (typed API, no nulls)
  const uniqueHashes = [...new Set(mirrorHashes.filter(h => h.trim().length > 0))];
  if (uniqueHashes.length === 0) {
    return ok(new Map());
  }

  const result = new Map<string, ChunkRow[]>();

  // Batch queries to respect SQLite parameter limit
  for (let i = 0; i < uniqueHashes.length; i += SQLITE_MAX_PARAMS) {
    const batch = uniqueHashes.slice(i, i + SQLITE_MAX_PARAMS);
    const placeholders = batch.map(() => '?').join(',');
    const sql = `SELECT * FROM content_chunks
                 WHERE mirror_hash IN (${placeholders})
                 ORDER BY mirror_hash, seq`;
    const rows = db.query<DbChunkRow, string[]>(sql).all(...batch);

    // Group by mirrorHash, preserving seq order
    for (const row of rows) {
      const mapped = mapChunkRow(row);
      const existing = result.get(mapped.mirrorHash) ?? [];
      existing.push(mapped);
      result.set(mapped.mirrorHash, existing);
    }
  }

  return ok(result);
}
```

### 3. Refactor vsearch.ts

**File**: `src/pipeline/vsearch.ts` (lines 100-131)

Before:

```typescript
for (const vec of vecResults) {
  let chunks = chunkCache.get(vec.mirrorHash);
  if (!chunks) {
    const chunksResult = await store.getChunks(vec.mirrorHash);
    // ...
  }
}
```

After:

```typescript
// Pre-fetch all chunks in one query
const uniqueHashes = [...new Set(vecResults.map((v) => v.mirrorHash))];
const chunksMapResult = await store.getChunksBatch(uniqueHashes);
if (!chunksMapResult.ok) {
  return err(chunksMapResult.error);
}
const chunksMap = chunksMapResult.value;

for (const vec of vecResults) {
  const chunks = chunksMap.get(vec.mirrorHash) ?? [];
  // ... rest of logic (remove chunkCache, remove per-hit getChunks calls)
}
```

### 4. Refactor hybrid.ts result-building loop

**File**: `src/pipeline/hybrid.ts` (lines 346-382, 413-417)

The main N+1 in hybrid is the result-building loop that fetches chunks per unique mirrorHash:

```typescript
// Before: N distinct getChunks() calls via chunksCache pattern
const chunksCache = new Map<string, ChunkRow[]>();
// ... per-candidate: store.getChunks(mirrorHash) if not cached

// After: Single batch prefetch before result building
const neededHashes = [...new Set(candidates.map((c) => c.mirrorHash))];
const chunksMapResult = await store.getChunksBatch(neededHashes);
if (!chunksMapResult.ok) return err(chunksMapResult.error);
const chunksMap = chunksMapResult.value;

// Then iterate candidates using chunksMap.get(mirrorHash) ?? []
```

### 5. Refactor rerank.ts

**File**: `src/pipeline/rerank.ts` (lines 123-144)

Same pattern: prefetch `chunksMap` before rerank loop.

### 6. Update test mocks

All test mocks implementing StorePort must include `getChunksBatch`:

**Files**: `test/pipeline/*.test.ts`, any mock StorePort

```typescript
const mockStore: Partial<StorePort> = {
  getChunks: async () => {
    throw new Error("getChunks should not be called");
  },
  getChunksBatch: async (hashes) => ok(new Map(/* test data */)),
  // ...
};
```

This ensures pipelines use batch method and don't fall back to per-hit calls.

### 7. Tests

**Unit tests** (`test/store/adapter.test.ts`):

- Empty input returns empty Map
- Single hash equivalence to `getChunks()`
- Multiple unique hashes (verify ordering preserved)
- Duplicate hashes in input (deduped)
- Mix of existing/non-existing hashes
- Empty string filtering
- Large batch (>900 hashes) correctly batched

**Pipeline tests** (`test/pipeline/*.test.ts`):

- Assert pipelines call `getChunksBatch()` not `getChunks()` per hit
- Mock `getChunks` to throw, ensuring N+1 removal is verified deterministically
- End-to-end vsearch/hybrid/rerank with batch chunks

## Risks & Dependencies

| Risk                         | Mitigation                                          |
| ---------------------------- | --------------------------------------------------- |
| Large batch (>999 params)    | Implemented batching with SQLITE_MAX_PARAMS=900     |
| Memory for large result sets | Typical case ~100KB; acceptable                     |
| Interface breakage           | Additive change only; keep existing `getChunks()`   |
| Test mocks break             | Explicitly update all mocks to implement new method |

**Dependencies**: None (builds on existing schema with `idx_chunks_mirror_hash` index)

## Acceptance Checks

- [ ] `getChunksBatch()` method added to StorePort and SqliteAdapter
- [ ] Parameter-limit batching implemented (SQLITE_MAX_PARAMS=900)
- [ ] Ordering guarantee documented and tested (seq ascending per hash)
- [ ] Unit tests pass for all edge cases (empty, duplicates, missing, large batch)
- [ ] vsearch.ts refactored to use batch (remove chunkCache)
- [ ] hybrid.ts result-building loop refactored to use batch
- [ ] rerank.ts refactored to use batch
- [ ] Test mocks updated; pipelines verified to not call `getChunks()` per hit
- [ ] `bun test` passes
- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes

## Test Notes

Verify N+1 removal deterministically:

```typescript
// Mock getChunks to throw - ensures pipeline uses batch
getChunks: async () => {
  throw new Error("N+1 detected");
};
```

## References

| File                                         | Lines            | Purpose                               |
| -------------------------------------------- | ---------------- | ------------------------------------- |
| `src/pipeline/vsearch.ts`                    | 100-131          | Primary N+1 location                  |
| `src/pipeline/hybrid.ts`                     | 346-382, 413-417 | Result-building N+1 (main hybrid win) |
| `src/pipeline/rerank.ts`                     | 123-144          | Rerank chunk fetch                    |
| `src/store/types.ts`                         | 405-419          | StorePort interface                   |
| `src/store/sqlite/adapter.ts`                | 553-571          | Existing getChunks impl               |
| `src/store/sqlite/adapter.ts`                | 587-606          | FTS JOIN pattern (model)              |
| `spec/db/schema.sql`                         | 137              | idx_chunks_mirror_hash index          |
| `test/store/adapter.test.ts`                 | -                | Existing store tests                  |
| `test/pipeline/rerank-normalization.test.ts` | -                | Mock StorePort to update              |

## Resolved Questions

1. **Return type**: Simple `Map<string, ChunkRow[]>`; caller uses `.get() ?? []`

2. **Ordering**: Each `ChunkRow[]` sorted by seq ascending (guaranteed by ORDER BY)

3. **Cache removal**: Remove redundant `chunkCache` from pipelines after refactor

4. **search.ts**: Evaluate after primary targets; FTS already JOINs

5. **Alternative approach**: Vector JOIN deferred; batch is simpler now
