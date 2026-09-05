import { expect, mock, test } from "bun:test";

import { NodeLlamaCppEmbedding } from "../../src/llm/nodeLlamaCpp/embedding";
import { NodeLlamaCppGeneration } from "../../src/llm/nodeLlamaCpp/generation";
import { ModelManager } from "../../src/llm/nodeLlamaCpp/lifecycle";
import { NodeLlamaCppRerank } from "../../src/llm/nodeLlamaCpp/rerank";

// This file runs in an isolated child; no global native mocks escape into the suite.
void mock.module("node-llama-cpp", () => ({
  LlamaChatSession: class {
    async prompt(input: string) {
      return input;
    }
  },
}));

function fixture() {
  const loads = new Map<string, number>();
  const disposed: string[] = [];
  let settle: (() => void) | undefined;
  let pause = false;
  const manager = new ModelManager(
    {
      activePreset: "test",
      presets: [],
      expandContextSize: 2048,
      warmModelTtl: 30,
      loadTimeout: 1000,
      inferenceTimeout: 1000,
    },
    true
  );
  const loadModel = async ({ modelPath }: { modelPath: string }) => {
    loads.set(modelPath, (loads.get(modelPath) ?? 0) + 1);
    let dead = false;
    const contexts: { disposed: boolean }[] = [];
    const context = () => {
      const result = {
        disposed: false,
        dispose: async () => {
          result.disposed = true;
        },
      };
      contexts.push(result);
      return result;
    };
    return {
      get disposed() {
        return dead;
      },
      embeddingVectorSize: 3,
      trainContextSize: 2048,
      vocabularyType: 2,
      fileInfo: {
        metadata: { general: { architecture: "bert" }, tokenizer: {} },
      },
      tokenize: (input: string) =>
        Array.from(input, (char) => char.charCodeAt(0)),
      dispose: async () => {
        dead = true;
        for (const ctx of contexts) ctx.disposed = true;
        disposed.push(modelPath);
      },
      createEmbeddingContext: async () =>
        Object.assign(context(), {
          getEmbeddingFor: async () => {
            if (pause)
              await new Promise<void>((resolve) => {
                settle = resolve;
              });
            return { vector: [1, 2, 3] };
          },
        }),
      createContext: async () =>
        Object.assign(context(), { getSequence: () => ({}) }),
      createRankingContext: async () =>
        Object.assign(context(), {
          rankAndSort: async (_query: string, documents: string[]) =>
            documents.map((document, index) => ({
              document,
              score: 1 / (index + 1),
            })),
        }),
    };
  };
  manager.getLlama = async () =>
    ({
      gpu: "cuda",
      cpuMathCores: 4,
      loadModel,
      dispose: async () => {},
    }) as never;
  return {
    manager,
    loads,
    disposed,
    pause() {
      pause = true;
    },
    settle() {
      pause = false;
      settle?.();
    },
  };
}

test("active embedding retains only its model while idle generation/rerank expire and reload exactly", async () => {
  const f = fixture();
  const embed = new NodeLlamaCppEmbedding(f.manager, "embed", "embed");
  const generation = new NodeLlamaCppGeneration(f.manager, "gen", "gen");
  const rank = new NodeLlamaCppRerank(f.manager, "rank", "rank");
  try {
    const beforeGen = await generation.generate("exact prompt", {
      maxTokens: 8,
    });
    const beforeRank = await rank.rerank("query", ["first", "second"]);
    expect(beforeGen.ok).toBe(true);
    expect(beforeRank.ok).toBe(true);
    f.pause();
    const controller = new AbortController();
    let completed = false;
    const active = embed
      .embed("same input", { signal: controller.signal })
      .then((result) => {
        completed = true;
        return result;
      });
    while (!f.manager.isLoaded("embed")) await Bun.sleep(1);
    // Abort cannot reclaim a noncooperative native evaluation before it settles.
    controller.abort();
    for (let i = 0; i < 8; i++) {
      for (const uri of ["gen", "rank"]) {
        const metadata = f.manager.acquireLease(uri, false);
        f.manager.getLoadedModel(uri);
        f.manager.getLifecycleStats();
        metadata.release();
      }
      await Bun.sleep(10);
    }
    expect(completed).toBe(false);
    expect(f.manager.getLoadedModels().map((model) => model.uri)).toEqual([
      "embed",
    ]);
    expect(f.disposed.sort()).toEqual(["gen", "rank"]);
    expect(f.manager.getLifecycleStats().activeLeases).toBe(1);
    f.settle();
    expect((await active).ok).toBe(false);
    expect(await embed.embed("same input")).toEqual({
      ok: true,
      value: [1, 2, 3],
    });
    expect(await generation.generate("exact prompt", { maxTokens: 8 })).toEqual(
      beforeGen
    );
    expect(await rank.rerank("query", ["first", "second"])).toEqual(beforeRank);
    expect(Object.fromEntries(f.loads)).toEqual({ gen: 2, rank: 2, embed: 1 });
  } finally {
    f.settle();
    await Promise.all([embed.dispose(), rank.dispose()]);
    await f.manager.disposeAll();
  }
});

test("metadata reads and init leases do not renew idle TTL; load and retirement retain ownership", async () => {
  const f = fixture();
  try {
    const lease = f.manager.acquireLease("embed", false);
    await f.manager.loadModel("embed", "embed", "embed");
    lease.release();
    for (let i = 0; i < 8; i++) {
      f.manager.getLoadedModel("embed");
      f.manager.getLifecycleStats();
      const metadata = f.manager.acquireLease("embed", false);
      metadata.release();
      await Bun.sleep(10);
    }
    expect(f.manager.isLoaded("embed")).toBe(false);
    let release!: () => void;
    const ready = Promise.withResolvers<void>();
    f.manager.getLlama = async () =>
      ({
        loadModel: async () => ({
          dispose: async () => {
            ready.resolve();
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          },
        }),
        dispose: async () => {},
      }) as never;
    const loadingLease = f.manager.acquireLease("rank");
    await f.manager.loadModel("rank", "rank", "rerank");
    await Bun.sleep(50);
    expect(f.manager.isLoaded("rank")).toBe(true);
    loadingLease.release();
    const retirement = f.manager.dispose("rank");
    await ready.promise;
    const nextLease = f.manager.acquireLease("rank");
    let reloaded = false;
    const reload = f.manager.loadModel("rank", "rank", "rerank").then(() => {
      reloaded = true;
    });
    await Bun.sleep(5);
    expect(reloaded).toBe(false);
    release();
    await retirement;
    await reload;
    expect(reloaded).toBe(true);
    // Restore immediate disposal before final cleanup.
    const model = f.manager.getLoadedModel("rank")!;
    model.model.dispose = async () => {};
    nextLease.release();
  } finally {
    await f.manager.disposeAll();
  }
});
