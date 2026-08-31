import { describe, expect, mock, test } from "bun:test";

import type { EmbeddingPort } from "../../src/llm/types";
import type { StoreError, StoreResult } from "../../src/store/types";
import type {
  BacklogItem,
  VectorIndexPort,
  VectorRow,
} from "../../src/store/vector";

import {
  embedAndStoreBatch,
  UPSERT_CONTENTION_BASE_DELAY_MS,
  UPSERT_CONTENTION_BACKOFF_FACTOR,
  UPSERT_CONTENTION_ERROR_SAMPLE,
  UPSERT_CONTENTION_JITTER_RATIO,
  UPSERT_CONTENTION_MAX_ATTEMPTS,
  UPSERT_CONTENTION_MAX_DELAY_MS,
  upsertContentionDelayMs,
} from "../../src/embed/retry";

const ZERO_DELAYS = [0, 0, 0, 0];

const ITEMS: BacklogItem[] = [
  {
    mirrorHash: "abc123",
    seq: 0,
    text: "first content",
    title: "First",
    reason: "new",
  },
  {
    mirrorHash: "abc123",
    seq: 1,
    text: "second content",
    title: "Second",
    reason: "new",
  },
];

function createEmbedPort(): EmbeddingPort {
  return {
    embedBatch: mock((texts: string[]) =>
      Promise.resolve({
        ok: true as const,
        value: texts.map(() => [0.1, 0.2, 0.3]),
      })
    ),
    embed: mock(() =>
      Promise.resolve({ ok: true as const, value: [0.1, 0.2, 0.3] })
    ),
    dimensions: () => 3,
    init: () => Promise.resolve({ ok: true as const, value: undefined }),
    dispose: () => Promise.resolve(),
    modelUri: "hf:test/embed.gguf",
  } as unknown as EmbeddingPort;
}

function busyError(
  code: "SQLITE_BUSY" | "SQLITE_LOCKED" = "SQLITE_BUSY"
): StoreError {
  return {
    code: "VECTOR_WRITE_FAILED",
    message: "database is locked",
    cause: { code },
  };
}

function busyCarryingError(): StoreError {
  return {
    code: "SQLITE_BUSY",
    message: "database is locked",
  } as unknown as StoreError;
}

function ioError(): StoreError {
  return {
    code: "VECTOR_WRITE_FAILED",
    message: "Vector write failed: disk I/O error",
  };
}

function createVectorIndex(
  upsert: (rows: VectorRow[]) => Promise<StoreResult<void>>
): VectorIndexPort {
  return {
    searchAvailable: true,
    model: "hf:test/embed.gguf",
    dimensions: 3,
    vecDirty: false,
    upsertVectors: mock(upsert),
    deleteVectorsForMirror: mock(() =>
      Promise.resolve({ ok: true as const, value: undefined })
    ),
    searchNearest: mock(() =>
      Promise.resolve({ ok: true as const, value: [] })
    ),
    rebuildVecIndex: mock(() =>
      Promise.resolve({ ok: true as const, value: undefined })
    ),
    syncVecIndex: mock(() =>
      Promise.resolve({ ok: true as const, value: { added: 0, removed: 0 } })
    ),
  } as unknown as VectorIndexPort;
}

describe("upsertContentionDelayMs", () => {
  test("applies exponential backoff with jitter and a per-delay cap", () => {
    const noJitter = () => 0.5;
    expect(upsertContentionDelayMs(0, noJitter)).toBe(
      UPSERT_CONTENTION_BASE_DELAY_MS
    );
    expect(upsertContentionDelayMs(1, noJitter)).toBe(
      UPSERT_CONTENTION_BASE_DELAY_MS * UPSERT_CONTENTION_BACKOFF_FACTOR
    );

    const minJitter = () => 0;
    expect(upsertContentionDelayMs(0, minJitter)).toBe(
      UPSERT_CONTENTION_BASE_DELAY_MS * (1 - UPSERT_CONTENTION_JITTER_RATIO)
    );

    const maxJitter = () => 1;
    const uncapped =
      UPSERT_CONTENTION_BASE_DELAY_MS *
      UPSERT_CONTENTION_BACKOFF_FACTOR ** 8 *
      (1 + UPSERT_CONTENTION_JITTER_RATIO);
    expect(uncapped).toBeGreaterThan(UPSERT_CONTENTION_MAX_DELAY_MS);
    expect(upsertContentionDelayMs(8, maxJitter)).toBe(
      UPSERT_CONTENTION_MAX_DELAY_MS
    );
  });
});

describe("embedAndStoreBatch SQLITE_BUSY persistence", () => {
  test("retries a twice-busy upsert then reports a successful embed, not a failure", async () => {
    let calls = 0;
    const vectorIndex = createVectorIndex(() => {
      calls += 1;
      if (calls <= 2) {
        return Promise.resolve({ ok: false, error: busyCarryingError() });
      }
      return Promise.resolve({ ok: true, value: undefined });
    });

    const result = await embedAndStoreBatch({
      embedPort: createEmbedPort(),
      vectorIndex,
      items: ITEMS,
      modelUri: "hf:test/embed.gguf",
      embedFingerprint: "fp",
      delays: ZERO_DELAYS,
    });

    expect(calls).toBe(3);
    expect(result.embedded).toBe(ITEMS.length);
    expect(result.errors).toBe(0);
    expect(result.contentionErrors).toBe(0);
    expect(result.batchFailed).toBe(false);
  });

  test("exhausted SQLITE_BUSY retries count as contention, not embed failures", async () => {
    let calls = 0;
    const vectorIndex = createVectorIndex(() => {
      calls += 1;
      return Promise.resolve({ ok: false, error: busyError() });
    });

    const result = await embedAndStoreBatch({
      embedPort: createEmbedPort(),
      vectorIndex,
      items: ITEMS,
      modelUri: "hf:test/embed.gguf",
      embedFingerprint: "fp",
      delays: ZERO_DELAYS,
    });

    expect(calls).toBe(UPSERT_CONTENTION_MAX_ATTEMPTS);
    expect(result.embedded).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.contentionErrors).toBe(ITEMS.length);
    expect(result.errorSamples).toEqual([UPSERT_CONTENTION_ERROR_SAMPLE]);
    expect(result.suggestion).toBe(UPSERT_CONTENTION_ERROR_SAMPLE);
    expect(result.suggestion).toContain("SQLITE_BUSY");
    expect(result.suggestion).toContain("gno embed");
  });

  test("a non-contention store failure keeps legacy error counting", async () => {
    let calls = 0;
    const vectorIndex = createVectorIndex(() => {
      calls += 1;
      return Promise.resolve({ ok: false, error: ioError() });
    });

    const result = await embedAndStoreBatch({
      embedPort: createEmbedPort(),
      vectorIndex,
      items: ITEMS,
      modelUri: "hf:test/embed.gguf",
      embedFingerprint: "fp",
      delays: ZERO_DELAYS,
    });

    expect(calls).toBe(1);
    expect(result.embedded).toBe(0);
    expect(result.errors).toBe(ITEMS.length);
    expect(result.contentionErrors).toBe(0);
    expect(result.errorSamples).toEqual([
      "Vector write failed: disk I/O error",
    ]);
    expect(result.suggestion).toContain("Store write failed");
  });
});
