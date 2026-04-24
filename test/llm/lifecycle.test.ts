import { afterEach, describe, expect, mock, test } from "bun:test";

const mockGetLlama = mock(async (_options?: unknown) => ({
  loadModel: mock(async () => ({
    dispose: async () => {
      // no-op
    },
  })),
}));

void mock.module("node-llama-cpp", () => ({
  getLlama: mockGetLlama,
  LlamaLogLevel: {
    error: "error",
  },
}));

describe("ModelManager", () => {
  afterEach(async () => {
    mockGetLlama.mockClear();
    const lifecycle = await import("../../src/llm/nodeLlamaCpp/lifecycle");
    await lifecycle.resetModelManager();
  });

  test("uses autoAttempt build mode when initializing llama", async () => {
    const { ModelManager } =
      await import("../../src/llm/nodeLlamaCpp/lifecycle");

    const manager = new ModelManager({
      activePreset: "slim",
      presets: [],
      loadTimeout: 60_000,
      inferenceTimeout: 30_000,
      expandContextSize: 2_048,
      warmModelTtl: 300_000,
    });

    const first = await manager.getLlama();
    const second = await manager.getLlama();

    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(mockGetLlama).toHaveBeenCalledTimes(1);
    expect(mockGetLlama).toHaveBeenCalledWith({
      build: "autoAttempt",
      gpu: "auto",
      logLevel: "error",
    });
  });

  test("resolves GPU env values", async () => {
    const { resolveLlamaGpuMode } =
      await import("../../src/llm/nodeLlamaCpp/lifecycle");

    expect(resolveLlamaGpuMode({})).toBe("auto");
    expect(resolveLlamaGpuMode({ GNO_LLAMA_GPU: "metal" })).toBe("metal");
    expect(resolveLlamaGpuMode({ NODE_LLAMA_CPP_GPU: "cuda" })).toBe("cuda");
    expect(resolveLlamaGpuMode({ GNO_LLAMA_GPU: "off" })).toBe(false);
    expect(resolveLlamaGpuMode({ GNO_LLAMA_GPU: "bogus" })).toBe("auto");
  });
});
