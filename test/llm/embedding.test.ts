import { describe, expect, mock, test } from "bun:test";

import { NodeLlamaCppEmbedding } from "../../src/llm/nodeLlamaCpp/embedding";

interface MockEmbeddingContext {
  dispose: ReturnType<typeof mock<() => Promise<void>>>;
  getEmbeddingFor: ReturnType<
    typeof mock<(text: string) => Promise<{ vector: number[] }>>
  >;
}

function createContext(
  contextId: number,
  calls: Array<{ contextId: number; text: string }>
): MockEmbeddingContext {
  return {
    dispose: mock(() => Promise.resolve()),
    getEmbeddingFor: mock(async (text: string) => {
      calls.push({ contextId, text });
      await Promise.resolve();
      return { vector: [contextId, text.length] };
    }),
  };
}

function createManager(options?: {
  cpuMathCores?: number;
  gpu?: false | "cuda";
  contexts?: MockEmbeddingContext[];
  failAtContextIndex?: number;
  trainContextSize?: number;
}) {
  const calls: Array<{ contextId: number; text: string }> = [];
  let createContextCallCount = 0;
  const contexts = options?.contexts ?? [
    createContext(1, calls),
    createContext(2, calls),
    createContext(3, calls),
    createContext(4, calls),
  ];

  const resolvedCpuMathCores = options?.cpuMathCores ?? 16;
  const resolvedPoolSize =
    options?.gpu === false || options?.gpu === undefined
      ? Math.max(1, Math.min(4, Math.ceil(resolvedCpuMathCores / 4)))
      : 1;
  const expectedOptions =
    options?.gpu === false || options?.gpu === undefined
      ? {
          threads: Math.max(
            1,
            Math.floor(resolvedCpuMathCores / resolvedPoolSize)
          ),
        }
      : undefined;

  const createEmbeddingContext = mock(async (opts?: { threads?: number }) => {
    const currentIndex = createContextCallCount;
    createContextCallCount += 1;

    if (options?.failAtContextIndex === currentIndex) {
      throw new Error("context creation failed");
    }

    const context = contexts[currentIndex];
    if (!context) {
      throw new Error("missing context");
    }

    expect(opts).toEqual(expectedOptions);
    return context;
  });

  const manager = {
    getLlama: mock(async () => ({
      cpuMathCores: options?.cpuMathCores ?? 16,
      gpu: options?.gpu ?? false,
    })),
    loadModel: mock(async () => ({
      ok: true as const,
      value: {
        model: {
          createEmbeddingContext,
          embeddingVectorSize: 2,
          trainContextSize: options?.trainContextSize,
          tokenize: (text: string) => text.split(""),
          detokenize: (tokens: readonly string[]) => tokens.join(""),
        },
      },
    })),
  };

  return { calls, contexts, createEmbeddingContext, manager };
}

describe("NodeLlamaCppEmbedding", () => {
  test("creates a CPU context pool capped at 4", async () => {
    const { createEmbeddingContext, manager } = createManager({
      cpuMathCores: 16,
    });
    const embedding = new NodeLlamaCppEmbedding(
      manager as never,
      "test-model",
      "/tmp/model.gguf"
    );

    const result = await embedding.init();

    expect(result.ok).toBe(true);
    expect(createEmbeddingContext).toHaveBeenCalledTimes(4);
    expect(embedding.dimensions()).toBe(2);
  });

  test("keeps a single context when GPU is enabled", async () => {
    const { createEmbeddingContext, manager } = createManager({
      gpu: "cuda",
      cpuMathCores: 16,
    });
    const embedding = new NodeLlamaCppEmbedding(
      manager as never,
      "test-model",
      "/tmp/model.gguf"
    );

    const result = await embedding.init();

    expect(result.ok).toBe(true);
    expect(createEmbeddingContext).toHaveBeenCalledTimes(1);
  });

  test("falls back to fewer contexts if additional ones fail to create", async () => {
    const { createEmbeddingContext, manager } = createManager({
      cpuMathCores: 16,
      failAtContextIndex: 1,
    });
    const embedding = new NodeLlamaCppEmbedding(
      manager as never,
      "test-model",
      "/tmp/model.gguf"
    );

    const initResult = await embedding.init();
    const embedResult = await embedding.embed("hello");

    expect(initResult.ok).toBe(true);
    expect(embedResult.ok).toBe(true);
    expect(createEmbeddingContext).toHaveBeenCalledTimes(2);
  });

  test("distributes batch work across contexts and preserves order", async () => {
    const { calls, manager } = createManager({ cpuMathCores: 8 });
    const embedding = new NodeLlamaCppEmbedding(
      manager as never,
      "test-model",
      "/tmp/model.gguf"
    );

    const result = await embedding.embedBatch(["a", "bb", "ccc", "dddd"]);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected ok result");
    }

    expect(result.value).toEqual([
      [1, 1],
      [2, 2],
      [1, 3],
      [2, 4],
    ]);
    expect(calls).toHaveLength(4);
    expect(calls.filter((call) => call.contextId === 1)).toHaveLength(2);
    expect(calls.filter((call) => call.contextId === 2)).toHaveLength(2);
  });

  test("truncates oversized embedding input by token limit", async () => {
    const { calls, manager } = createManager({
      cpuMathCores: 4,
      trainContextSize: 8,
    });
    const embedding = new NodeLlamaCppEmbedding(
      manager as never,
      "test-model",
      "/tmp/model.gguf"
    );

    const result = await embedding.embed("abcdefghijk");

    expect(result.ok).toBe(true);
    expect(calls[0]?.text).toBe("abcd");
  });

  test("truncates oversized batch items before embedding", async () => {
    const { calls, manager } = createManager({
      cpuMathCores: 4,
      trainContextSize: 7,
    });
    const embedding = new NodeLlamaCppEmbedding(
      manager as never,
      "test-model",
      "/tmp/model.gguf"
    );

    const result = await embedding.embedBatch(["abcdef", "xy"]);

    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.text)).toEqual(["abc", "xy"]);
  });

  test("disposes contexts created after a concurrent dispose", async () => {
    let resolveContext: ((context: MockEmbeddingContext) => void) | undefined;
    const delayedContext = createContext(1, []);
    const createEmbeddingContext = mock(
      () =>
        new Promise<MockEmbeddingContext>((resolve) => {
          resolveContext = resolve;
        })
    );

    const manager = {
      getLlama: mock(async () => ({
        cpuMathCores: 4,
        gpu: false,
      })),
      loadModel: mock(async () => ({
        ok: true as const,
        value: {
          model: {
            createEmbeddingContext,
            embeddingVectorSize: 2,
          },
        },
      })),
    };

    const embedding = new NodeLlamaCppEmbedding(
      manager as never,
      "test-model",
      "/tmp/model.gguf"
    );

    const initPromise = embedding.init();
    while (createEmbeddingContext.mock.calls.length === 0) {
      await Promise.resolve();
    }
    await embedding.dispose();
    resolveContext?.(delayedContext);

    const result = await initPromise;

    expect(result.ok).toBe(false);
    expect(delayedContext.dispose).toHaveBeenCalledTimes(1);
  });
});
