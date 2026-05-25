import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  NodeLlamaCppEmbedding,
  resolveEmbeddingContextPoolSize,
} from "../../src/llm/nodeLlamaCpp/embedding";

interface MockEmbeddingContext {
  dispose: ReturnType<typeof mock<() => Promise<void>>>;
  getEmbeddingFor: ReturnType<
    typeof mock<
      (input: string | readonly number[]) => Promise<{ vector: number[] }>
    >
  >;
}

function createContext(
  contextId: number,
  calls: Array<{ contextId: number; input: string | readonly number[] }>
): MockEmbeddingContext {
  return {
    dispose: mock(() => Promise.resolve()),
    getEmbeddingFor: mock(async (input: string | readonly number[]) => {
      calls.push({ contextId, input });
      await Promise.resolve();
      return { vector: [contextId, input.length] };
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
  const calls: Array<{ contextId: number; input: string | readonly number[] }> =
    [];
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
      ? process.env.GNO_EMBED_CONTEXTS
        ? Number.parseInt(process.env.GNO_EMBED_CONTEXTS, 10)
        : Math.max(1, Math.min(2, Math.ceil(resolvedCpuMathCores / 4)))
      : 1;
  const expectedOptions =
    options?.gpu === false || options?.gpu === undefined
      ? {
          contextSize: process.env.GNO_EMBED_CONTEXT_SIZE
            ? Number.parseInt(process.env.GNO_EMBED_CONTEXT_SIZE, 10)
            : 2_048,
          threads: process.env.GNO_EMBED_THREADS
            ? Number.parseInt(process.env.GNO_EMBED_THREADS, 10)
            : Math.max(1, Math.floor(resolvedCpuMathCores / resolvedPoolSize)),
        }
      : {
          contextSize: process.env.GNO_EMBED_CONTEXT_SIZE
            ? Number.parseInt(process.env.GNO_EMBED_CONTEXT_SIZE, 10)
            : 2_048,
        };

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
          tokenize: (text: string) =>
            Array.from(text, (char) => char.charCodeAt(0)),
          detokenize: (tokens: readonly number[]) =>
            tokens.map((token) => String.fromCharCode(token)).join(""),
        },
      },
    })),
  };

  return { calls, contexts, createEmbeddingContext, manager };
}

describe("NodeLlamaCppEmbedding", () => {
  afterEach(() => {
    delete process.env.GNO_EMBED_CONTEXTS;
    delete process.env.GNO_EMBED_CONTEXT_SIZE;
    delete process.env.GNO_EMBED_THREADS;
  });

  test("keeps CPU context pool single on constrained Windows machines", () => {
    expect(
      resolveEmbeddingContextPoolSize({
        gpu: false,
        cpuMathCores: 16,
        platformName: "win32",
        totalMemoryBytes: 12 * 1024 * 1024 * 1024,
      })
    ).toBe(1);
  });

  test("uses two CPU contexts on 16GB Windows machines", () => {
    expect(
      resolveEmbeddingContextPoolSize({
        gpu: false,
        cpuMathCores: 16,
        platformName: "win32",
        totalMemoryBytes: 16 * 1024 * 1024 * 1024,
      })
    ).toBe(2);
  });

  test("caps default adaptive CPU context pool at two on 24GB Windows machines", () => {
    expect(
      resolveEmbeddingContextPoolSize({
        gpu: false,
        cpuMathCores: 16,
        platformName: "win32",
        totalMemoryBytes: 24 * 1024 * 1024 * 1024,
      })
    ).toBe(2);
  });

  test("keeps CPU context pool adaptive outside low-memory Windows capped at two", () => {
    expect(
      resolveEmbeddingContextPoolSize({
        gpu: false,
        cpuMathCores: 16,
        platformName: "darwin",
        totalMemoryBytes: 16 * 1024 * 1024 * 1024,
      })
    ).toBe(2);
  });

  test("allows explicit CPU context pool override", () => {
    expect(
      resolveEmbeddingContextPoolSize({
        env: { GNO_EMBED_CONTEXTS: "3" },
        gpu: false,
        cpuMathCores: 16,
        platformName: "win32",
        totalMemoryBytes: 16 * 1024 * 1024 * 1024,
      })
    ).toBe(3);
  });

  test("creates a CPU context pool capped at 4", async () => {
    process.env.GNO_EMBED_CONTEXTS = "4";
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

  test("allows explicit CPU threads per embedding context override", async () => {
    process.env.GNO_EMBED_CONTEXTS = "2";
    process.env.GNO_EMBED_THREADS = "6";
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
    expect(createEmbeddingContext).toHaveBeenCalledWith({
      contextSize: 2_048,
      threads: 6,
    });
  });

  test("allows explicit embedding context size override", async () => {
    process.env.GNO_EMBED_CONTEXTS = "1";
    process.env.GNO_EMBED_CONTEXT_SIZE = "512";
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
    expect(createEmbeddingContext).toHaveBeenCalledWith({
      contextSize: 512,
      threads: 16,
    });
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
    process.env.GNO_EMBED_CONTEXTS = "4";
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
    process.env.GNO_EMBED_CONTEXTS = "2";
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
    expect(calls[0]?.input).toEqual([97, 98, 99, 100]);
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
    expect(calls.map((call) => call.input)).toEqual([
      [97, 98, 99],
      [120, 121],
    ]);
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
