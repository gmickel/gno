import { describe, expect, mock, test } from "bun:test";

import type { EmbeddingPort } from "../../src/llm/types";

import { embedTextsWithRecovery } from "../../src/embed/batch";

function createEmbedPort(
  options: {
    modelUri?: string;
    batchOk?: boolean;
    batchValues?: number[][];
    batchFailsForLengths?: number[];
    singleFailures?: number[];
  } = {}
) {
  const failures = new Set(options.singleFailures ?? []);
  const batchLengthFailures = new Set(options.batchFailsForLengths ?? []);
  let singleCall = 0;
  const embedBatch = mock(async (texts: string[]) => {
    if (options.batchOk === false || batchLengthFailures.has(texts.length)) {
      return {
        ok: false as const,
        error: {
          code: "INFERENCE_FAILED" as const,
          message: "batch failed",
          retryable: true,
        },
      };
    }
    return {
      ok: true as const,
      value:
        options.batchValues ??
        texts.map((_, idx) => [idx + 0.1, idx + 0.2, idx + 0.3]),
    };
  });
  const embed = mock(async () => {
    const current = singleCall;
    singleCall += 1;
    if (failures.has(current)) {
      return {
        ok: false as const,
        error: {
          code: "INFERENCE_FAILED" as const,
          message: "single failed",
          retryable: true,
        },
      };
    }
    return {
      ok: true as const,
      value: [current + 0.1, current + 0.2, current + 0.3],
    };
  });

  return {
    embed,
    embedBatch,
    modelUri: options.modelUri ?? "hf:test/embed.gguf",
    init: mock(async () => ({ ok: true as const, value: undefined })),
    dimensions: () => 3,
    dispose: mock(async () => undefined),
  } as unknown as EmbeddingPort;
}

describe("embedTextsWithRecovery", () => {
  test("uses batch embeddings for trusted models", async () => {
    const embedPort = createEmbedPort();
    const { embedBatch, embed } = embedPort as unknown as {
      embedBatch: ReturnType<typeof mock>;
      embed: ReturnType<typeof mock>;
    };

    const result = await embedTextsWithRecovery(embedPort, ["a", "b"]);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.batchFailed).toBe(false);
    expect(result.value.vectors).toHaveLength(2);
    expect(embedBatch).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledTimes(0);
  });

  test("falls back to per-item embedding when batch fails", async () => {
    const embedPort = createEmbedPort({ batchOk: false });
    const { embed } = embedPort as unknown as {
      embed: ReturnType<typeof mock>;
    };

    const result = await embedTextsWithRecovery(embedPort, ["a", "b"]);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.batchFailed).toBe(true);
    expect(result.value.batchError).toContain("batch failed");
    expect(result.value.vectors).toEqual([
      [0.1, 0.2, 0.3],
      [1.1, 1.2, 1.3],
    ]);
    expect(result.value.fallbackErrors).toBe(0);
    expect(result.value.retrySuggestion).toBeUndefined();
    expect(embed).toHaveBeenCalledTimes(2);
  });

  test("recovers partially when some single-item fallbacks fail", async () => {
    const embedPort = createEmbedPort({
      batchOk: false,
      singleFailures: [1],
    });

    const result = await embedTextsWithRecovery(embedPort, ["a", "b", "c"]);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.batchFailed).toBe(true);
    expect(result.value.vectors).toEqual([
      [0.1, 0.2, 0.3],
      null,
      [2.1, 2.2, 2.3],
    ]);
    expect(result.value.fallbackErrors).toBe(1);
    expect(result.value.failureSamples).toEqual(["single failed"]);
    expect(result.value.retrySuggestion).toContain("--batch-size 1");
  });

  test("skips batch mode for untrusted compatibility profiles", async () => {
    const embedPort = createEmbedPort({
      modelUri:
        "hf:jinaai/jina-embeddings-v4-text-code-GGUF/jina-embeddings-v4-text-code-Q5_K_M.gguf",
    });
    const { embedBatch, embed } = embedPort as unknown as {
      embedBatch: ReturnType<typeof mock>;
      embed: ReturnType<typeof mock>;
    };

    const result = await embedTextsWithRecovery(embedPort, ["a", "b"]);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.batchFailed).toBe(true);
    expect(result.value.batchError).toContain("disabled");
    expect(embedBatch).toHaveBeenCalledTimes(0);
    expect(embed).toHaveBeenCalledTimes(2);
  });

  test("downshifts to smaller batches before falling back to single-item embeds", async () => {
    const embedPort = createEmbedPort({
      batchFailsForLengths: [4],
    });
    const { embedBatch, embed } = embedPort as unknown as {
      embedBatch: ReturnType<typeof mock>;
      embed: ReturnType<typeof mock>;
    };

    const result = await embedTextsWithRecovery(embedPort, [
      "a",
      "b",
      "c",
      "d",
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.batchFailed).toBe(true);
    expect(result.value.vectors).toEqual([
      [0.1, 0.2, 0.3],
      [1.1, 1.2, 1.3],
      [0.1, 0.2, 0.3],
      [1.1, 1.2, 1.3],
    ]);
    expect(embedBatch).toHaveBeenCalledTimes(3);
    expect(embed).toHaveBeenCalledTimes(0);
  });

  test("resets the embedding port when a whole failed batch becomes unrecoverable", async () => {
    let reset = false;
    const embed = mock(async () => {
      if (!reset) {
        return {
          ok: false as const,
          error: {
            code: "INFERENCE_FAILED" as const,
            message: "single failed",
            cause: "worker poisoned",
            retryable: true,
          },
        };
      }
      return {
        ok: true as const,
        value: [0.5, 0.6, 0.7],
      };
    });
    const embedBatch = mock(async () => ({
      ok: false as const,
      error: {
        code: "INFERENCE_FAILED" as const,
        message: "batch failed",
        cause: "worker poisoned",
        retryable: true,
      },
    }));
    const init = mock(async () => ({ ok: true as const, value: undefined }));
    const dispose = mock(async () => {
      reset = true;
    });
    const embedPort = {
      embed,
      embedBatch,
      init,
      dispose,
      modelUri: "hf:test/embed.gguf",
      dimensions: () => 3,
    } as unknown as EmbeddingPort;

    const result = await embedTextsWithRecovery(embedPort, ["a", "b"]);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledTimes(1);
    expect(result.value.fallbackErrors).toBe(0);
    expect(result.value.vectors).toEqual([
      [0.5, 0.6, 0.7],
      [0.5, 0.6, 0.7],
    ]);
  });
});
