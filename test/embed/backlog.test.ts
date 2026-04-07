/**
 * Tests for embed backlog processor.
 *
 * @module test/embed/backlog
 */

import { describe, expect, mock, test } from "bun:test";

import type { EmbeddingPort } from "../../src/llm/types";
import type {
  VectorIndexPort,
  VectorRow,
  VectorStatsPort,
} from "../../src/store/vector";

import { embedBacklog } from "../../src/embed/backlog";

// ─────────────────────────────────────────────────────────────────────────────
// Test Mocks
// ─────────────────────────────────────────────────────────────────────────────

function createMockStatsPort(
  backlog: Array<{
    mirrorHash: string;
    seq: number;
    text: string;
    title?: string;
  }> = []
) {
  let called = false;
  return {
    getBacklog: mock(() => {
      // Return backlog on first call, empty on subsequent (cursor-based)
      if (!called) {
        called = true;
        return Promise.resolve({ ok: true, value: backlog });
      }
      return Promise.resolve({ ok: true, value: [] });
    }),
    countBacklog: mock(() =>
      Promise.resolve({ ok: true, value: backlog.length })
    ),
    countVectors: mock(() => Promise.resolve({ ok: true, value: 0 })),
  } as unknown as VectorStatsPort;
}

function createMockEmbedPort() {
  return {
    embedBatch: mock((texts: string[]) =>
      Promise.resolve({
        ok: true,
        value: texts.map(() => [0.1, 0.2, 0.3]),
      })
    ),
    embed: mock(() => Promise.resolve({ ok: true, value: [0.1, 0.2, 0.3] })),
    dimensions: () => 3,
    init: () => Promise.resolve({ ok: true }),
    dispose: () => Promise.resolve(),
  } as unknown as EmbeddingPort;
}

interface MockVectorIndex extends VectorIndexPort {
  _syncCalled: boolean;
}

function createMockVectorIndex(
  opts: { vecDirty?: boolean; syncFails?: boolean } = {}
): MockVectorIndex {
  const index = {
    searchAvailable: true,
    model: "test-model",
    dimensions: 3,
    vecDirty: opts.vecDirty ?? false,
    _syncCalled: false,
    upsertVectors: mock(() => Promise.resolve({ ok: true })),
    deleteVectorsForMirror: mock(() => Promise.resolve({ ok: true })),
    searchNearest: mock(() => Promise.resolve({ ok: true, value: [] })),
    rebuildVecIndex: mock(() => Promise.resolve({ ok: true })),
    syncVecIndex: mock(() => {
      index._syncCalled = true;
      if (opts.syncFails) {
        return Promise.resolve({
          ok: false,
          error: { code: "VEC_SYNC_FAILED", message: "Test sync failure" },
        });
      }
      return Promise.resolve({ ok: true, value: { added: 1, removed: 0 } });
    }),
  };
  return index as unknown as MockVectorIndex;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("embedBacklog", () => {
  test("returns empty result when no backlog", async () => {
    const result = await embedBacklog({
      statsPort: createMockStatsPort([]),
      embedPort: createMockEmbedPort(),
      vectorIndex: createMockVectorIndex(),
      modelUri: "test-model",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.embedded).toBe(0);
      expect(result.value.errors).toBe(0);
      expect(result.value.syncError).toBeUndefined();
    }
  });

  test("embeds backlog items", async () => {
    const result = await embedBacklog({
      statsPort: createMockStatsPort([
        { mirrorHash: "abc123", seq: 0, text: "test content", title: "Test" },
      ]),
      embedPort: createMockEmbedPort(),
      vectorIndex: createMockVectorIndex(),
      modelUri: "test-model",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.embedded).toBe(1);
      expect(result.value.errors).toBe(0);
    }
  });

  test("syncs vec index when vecDirty is true after embedding", async () => {
    // Create index that becomes dirty during upsert
    const vectorIndex = createMockVectorIndex();
    vectorIndex.upsertVectors = mock(() => {
      vectorIndex.vecDirty = true; // Simulates vec0 write failure
      return Promise.resolve({ ok: true, value: undefined });
    }) as typeof vectorIndex.upsertVectors;

    const result = await embedBacklog({
      statsPort: createMockStatsPort([
        { mirrorHash: "abc123", seq: 0, text: "test content", title: "Test" },
      ]),
      embedPort: createMockEmbedPort(),
      vectorIndex,
      modelUri: "test-model",
    });

    expect(result.ok).toBe(true);
    expect(vectorIndex._syncCalled).toBe(true);
    expect(vectorIndex.vecDirty).toBe(false); // Cleared after successful sync
    if (result.ok) {
      expect(result.value.syncError).toBeUndefined();
    }
  });

  test("does not sync when vecDirty is false", async () => {
    const vectorIndex = createMockVectorIndex({ vecDirty: false });

    await embedBacklog({
      statsPort: createMockStatsPort([
        { mirrorHash: "abc123", seq: 0, text: "test content", title: "Test" },
      ]),
      embedPort: createMockEmbedPort(),
      vectorIndex,
      modelUri: "test-model",
    });

    expect(vectorIndex._syncCalled).toBe(false);
  });

  test("returns syncError when sync fails", async () => {
    const vectorIndex = createMockVectorIndex({ syncFails: true });
    vectorIndex.upsertVectors = mock(() => {
      vectorIndex.vecDirty = true;
      return Promise.resolve({ ok: true, value: undefined });
    }) as typeof vectorIndex.upsertVectors;

    const result = await embedBacklog({
      statsPort: createMockStatsPort([
        { mirrorHash: "abc123", seq: 0, text: "test content", title: "Test" },
      ]),
      embedPort: createMockEmbedPort(),
      vectorIndex,
      modelUri: "test-model",
    });

    expect(result.ok).toBe(true);
    expect(vectorIndex._syncCalled).toBe(true);
    if (result.ok) {
      expect(result.value.syncError).toBe("Test sync failure");
      expect(result.value.embedded).toBe(1);
    }
  });

  test("vecDirty not cleared when sync fails", async () => {
    const vectorIndex = createMockVectorIndex({ syncFails: true });
    vectorIndex.upsertVectors = mock(() => {
      vectorIndex.vecDirty = true;
      return Promise.resolve({ ok: true, value: undefined });
    }) as typeof vectorIndex.upsertVectors;

    await embedBacklog({
      statsPort: createMockStatsPort([
        { mirrorHash: "abc123", seq: 0, text: "test content", title: "Test" },
      ]),
      embedPort: createMockEmbedPort(),
      vectorIndex,
      modelUri: "test-model",
    });

    // vecDirty should still be true since sync failed
    expect(vectorIndex.vecDirty).toBe(true);
  });

  test("falls back to per-item embedding and stores partial successes", async () => {
    const embedPort = {
      embedBatch: mock(() =>
        Promise.resolve({
          ok: false as const,
          error: {
            code: "INFERENCE_FAILED" as const,
            message: "batch failed",
            retryable: true,
          },
        })
      ),
      embed: mock((text: string) =>
        Promise.resolve(
          text.includes("second")
            ? {
                ok: false as const,
                error: {
                  code: "INFERENCE_FAILED" as const,
                  message: "single failed",
                  retryable: true,
                },
              }
            : { ok: true as const, value: [0.1, 0.2, 0.3] }
        )
      ),
      dimensions: () => 3,
      init: () => Promise.resolve({ ok: true as const, value: undefined }),
      dispose: () => Promise.resolve(),
      modelUri: "hf:test/embed.gguf",
    } as unknown as EmbeddingPort;

    const vectorIndex = createMockVectorIndex();
    const upserts: VectorRow[][] = [];
    vectorIndex.upsertVectors = mock((rows: VectorRow[]) => {
      upserts.push(rows);
      return Promise.resolve({ ok: true as const, value: undefined });
    }) as typeof vectorIndex.upsertVectors;

    const result = await embedBacklog({
      statsPort: createMockStatsPort([
        { mirrorHash: "abc123", seq: 0, text: "first content", title: "First" },
        {
          mirrorHash: "abc123",
          seq: 1,
          text: "second content",
          title: "Second",
        },
      ]),
      embedPort,
      vectorIndex,
      modelUri: "hf:test/embed.gguf",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.embedded).toBe(1);
    expect(result.value.errors).toBe(1);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toHaveLength(1);
    expect(upserts[0]?.[0]?.seq).toBe(0);
  });
});
