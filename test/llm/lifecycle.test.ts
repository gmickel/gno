import { afterEach, describe, expect, mock, test } from "bun:test";

let mockPlatformValue: NodeJS.Platform = "darwin";

const mockGetLlama = mock(async (_options?: unknown) => ({
  loadModel: mock(async () => ({
    dispose: async () => {
      // no-op
    },
  })),
}));

void mock.module("node:os", () => ({
  arch: () => "arm64",
  homedir: () => process.env.HOME ?? "/tmp",
  hostname: () => "localhost",
  platform: () => mockPlatformValue,
  totalmem: () => 16 * 1024 * 1024 * 1024,
  tmpdir: () => "/tmp",
  userInfo: () => ({
    gid: 501,
    homedir: "/tmp",
    shell: "/bin/zsh",
    uid: 501,
    username: "test",
  }),
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
    mockGetLlama.mockImplementation(async (_options?: unknown) => ({
      loadModel: mock(async () => ({
        dispose: async () => {
          // no-op
        },
      })),
    }));
    mockPlatformValue = "darwin";
    delete process.env.GNO_LLAMA_BUILD;
    delete process.env.GNO_LLAMA_GPU;
    delete process.env.GNO_LLAMA_INIT_TIMEOUT_MS;
    const lifecycle = await import("../../src/llm/nodeLlamaCpp/lifecycle");
    await lifecycle.resetModelManager();
  });

  test("uses prebuilt-only build mode when initializing llama by default", async () => {
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
      build: "never",
      gpu: "auto",
      logLevel: "error",
    });
  });

  test("allows opt-in source builds for llama backends", async () => {
    process.env.GNO_LLAMA_BUILD = "autoAttempt";
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

    await manager.getLlama();

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

  test("resolves build env values", async () => {
    const { resolveLlamaBuildMode } =
      await import("../../src/llm/nodeLlamaCpp/lifecycle");

    expect(resolveLlamaBuildMode({})).toBe("never");
    expect(resolveLlamaBuildMode({ GNO_LLAMA_BUILD: "prebuilt" })).toBe(
      "never"
    );
    expect(resolveLlamaBuildMode({ GNO_LLAMA_BUILD: "autoAttempt" })).toBe(
      "autoAttempt"
    );
    expect(resolveLlamaBuildMode({ GNO_LLAMA_BUILD: "source" })).toBe(
      "autoAttempt"
    );
  });

  test("retries CPU when Windows auto backend initialization fails", async () => {
    mockPlatformValue = "win32";
    mockGetLlama
      .mockImplementationOnce(async () => {
        throw new Error("Binding binary load test timed out");
      })
      .mockImplementationOnce(async (_options?: unknown) => ({
        loadModel: mock(async () => ({
          dispose: async () => {
            // no-op
          },
        })),
      }));
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

    await manager.getLlama();

    expect(mockGetLlama.mock.calls).toHaveLength(2);
    expect(mockGetLlama.mock.calls[0]?.[0]).toEqual({
      build: "never",
      gpu: "auto",
      logLevel: "error",
    });
    expect(mockGetLlama.mock.calls[1]?.[0]).toEqual({
      build: "never",
      gpu: false,
      logLevel: "error",
    });
  });

  test("times out backend initialization", async () => {
    process.env.GNO_LLAMA_GPU = "false";
    process.env.GNO_LLAMA_INIT_TIMEOUT_MS = "1";
    mockGetLlama.mockImplementation(() => new Promise<never>(() => undefined));
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

    try {
      await manager.getLlama();
      throw new Error("expected getLlama to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Backend init timeout after 1ms");
    }
  });

  test("counts one physical load across warm reuse", async () => {
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

    const first = await manager.loadModel(
      "/tmp/model.gguf",
      "test:model",
      "embed"
    );
    const second = await manager.loadModel(
      "/tmp/model.gguf",
      "test:model",
      "embed"
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(manager.getLifecycleStats()).toMatchObject({
      loadedModels: 1,
      loadAttempts: 1,
      loadSuccesses: 1,
      loadFailures: 0,
      inflightLoads: 0,
    });
  });

  test("counts model failures without leaving an inflight load", async () => {
    mockGetLlama.mockImplementationOnce(async () => ({
      loadModel: mock(async () => {
        throw new Error("model load failed");
      }),
    }));
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

    const result = await manager.loadModel(
      "/tmp/broken.gguf",
      "test:broken",
      "rerank"
    );
    expect(result.ok).toBe(false);
    expect(manager.getLifecycleStats()).toMatchObject({
      loadedModels: 0,
      loadAttempts: 1,
      loadSuccesses: 0,
      loadFailures: 1,
      inflightLoads: 0,
    });
  });
});
