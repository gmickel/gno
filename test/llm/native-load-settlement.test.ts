import { expect, spyOn, test } from "bun:test";

import { ModelManager } from "../../src/llm/nodeLlamaCpp/lifecycle";

test("isolated loader retains ownership after timeout until noncooperative creation settles", async () => {
  const manager = new ModelManager(
    {
      activePreset: "synthetic",
      presets: [],
      loadTimeout: 10,
      inferenceTimeout: 100,
      expandContextSize: 2048,
      warmModelTtl: 1000,
    },
    true
  );
  const native = Promise.withResolvers<{ dispose(): Promise<void> }>();
  const started = Promise.withResolvers<void>();
  let loadAborted = false;
  let disposed = 0;
  const getLlama = spyOn(manager, "getLlama").mockResolvedValue({
    loadModel: ({ loadSignal }: { loadSignal: AbortSignal }) => {
      loadSignal.addEventListener("abort", () => {
        loadAborted = true;
      });
      started.resolve();
      return native.promise;
    },
  } as unknown as Awaited<ReturnType<ModelManager["getLlama"]>>);
  let delivered = false;
  const result = manager
    .loadModel("synthetic.gguf", "synthetic", "gen")
    .then((value) => {
      delivered = true;
      return value;
    });
  await started.promise;
  await Bun.sleep(30);
  expect(loadAborted).toBe(true);
  expect(delivered).toBe(false);
  expect(manager.getLifecycleStats().inflightLoads).toBe(1);
  native.resolve({
    dispose: async () => {
      disposed++;
    },
  });
  expect(await result).toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
  expect(disposed).toBe(1);
  expect(manager.getLifecycleStats().inflightLoads).toBe(0);
  expect(manager.getLifecycleStats().loadedModels).toBe(0);
  getLlama.mockRestore();
  await manager.disposeAll();
});
