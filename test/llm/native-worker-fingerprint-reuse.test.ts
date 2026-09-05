import { afterEach, expect, spyOn, test } from "bun:test";
// Bun has no temporary-directory, canonical-path or atomic-rename API.
import { mkdtemp, realpath, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ApprovedModel } from "../../src/llm/native-worker/protocol";

import { NativeDispatcher } from "../../src/llm/native-worker/dispatcher";
// Module namespace is needed for scoped hash instrumentation, never mock.module.
import * as embeddingIdentity from "../../src/llm/native-worker/embedding-identity";
import { NodeLlamaCppEmbedding } from "../../src/llm/nodeLlamaCpp/embedding";
import { ModelManager } from "../../src/llm/nodeLlamaCpp/lifecycle";
import { safeRm } from "../helpers/cleanup";

const dispatchers: NativeDispatcher[] = [];
const roots: string[] = [];
const restores: (() => void)[] = [];

afterEach(async () => {
  try {
    await Promise.all(dispatchers.splice(0).map((owner) => owner.dispose()));
  } finally {
    for (const restore of restores.splice(0).reverse()) restore();
    await Promise.all(roots.splice(0).map((root) => safeRm(root)));
  }
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gno-hash-reuse-")));
  roots.push(root);
  const path = join(root, "synthetic.gguf");
  await Bun.write(path, "synthetic weights A");
  const model: ApprovedModel = {
    id: "embedding",
    type: "embed",
    modelUri: "file:/synthetic.gguf",
    path,
  };
  const originalHash = embeddingIdentity.fingerprintModel;
  const hash = spyOn(embeddingIdentity, "fingerprintModel").mockImplementation(
    originalHash
  );
  const init = spyOn(NodeLlamaCppEmbedding.prototype, "init").mockResolvedValue(
    {
      ok: true,
      value: undefined,
    }
  );
  const dimensions = spyOn(
    NodeLlamaCppEmbedding.prototype,
    "dimensions"
  ).mockReturnValue(3);
  const context = spyOn(
    NodeLlamaCppEmbedding.prototype,
    "getContextIdentity"
  ).mockReturnValue({
    contextSize: 2048,
    truncationPolicy: "truncate-tail-tokens-v1:limit=2044",
    contextCount: 1,
    threadsPerContext: 4,
  });
  const llama = spyOn(ModelManager.prototype, "getLlama").mockResolvedValue({
    gpu: false,
    cpuMathCores: 4,
  } as Awaited<ReturnType<ModelManager["getLlama"]>>);
  // Every spy restores after this test; no native model or GPU is initialized.
  restores.push(
    () => hash.mockRestore(),
    () => init.mockRestore(),
    () => dimensions.mockRestore(),
    () => context.mockRestore(),
    () => llama.mockRestore()
  );
  let requestId = 0;
  function generation(number: number) {
    const owner = new NativeDispatcher({
      generation: number,
      models: [model],
      loadTimeout: 1000,
      inferenceTimeout: 1000,
      warmModelTtl: 300_000,
    });
    dispatchers.push(owner);
    return {
      owner,
      execute: (op: "init" | "dispose") =>
        owner.execute({
          version: 1,
          generation: number,
          requestId: ++requestId,
          modelId: model.id,
          op,
        }),
    };
  }
  return { root, path, model, hash, originalHash, init, generation };
}

test("port disposal reuses one verified hash; a new generation hashes independently", async () => {
  const { hash, init, generation } = await fixture();
  const first = generation(1);
  const initial = await first.execute("init");
  for (let call = 0; call < 3; call++) {
    await first.execute("dispose");
    const next = await first.execute("init");
    expect(next.response.result).toEqual(initial.response.result);
  }
  expect(init).toHaveBeenCalledTimes(4);
  expect(hash).toHaveBeenCalledTimes(1);
  const second = await generation(2).execute("init");
  expect(second.response.result).toEqual(initial.response.result);
  expect(hash).toHaveBeenCalledTimes(2);
});

test("individual model eviction retains verified fingerprint and rejects later artifact mutation", async () => {
  const { path, model, hash, generation } = await fixture();
  const first = generation(1);
  const manager = (first.owner as unknown as { manager: ModelManager }).manager;
  let disposed = 0;
  manager.getLlama = async () =>
    ({
      gpu: false,
      cpuMathCores: 4,
      loadModel: async () => ({
        dispose: async () => {
          disposed++;
        },
      }),
    }) as never;
  const initial = await first.execute("init");
  for (let attempt = 0; attempt < 2; attempt++) {
    await manager.loadModel(path, model.modelUri, "embed");
    await manager.dispose(model.modelUri);
    expect(manager.isLoaded(model.modelUri)).toBe(false);
    expect((await first.execute("init")).response.result).toEqual(
      initial.response.result
    );
  }
  expect(disposed).toBe(2);
  expect(hash).toHaveBeenCalledTimes(1);
  await Bun.write(path, "mutated after individual expiry");
  expect(
    await first.execute("init").catch((cause: unknown) => cause)
  ).toMatchObject({ reason: "stale_generation" });
  expect(hash).toHaveBeenCalledTimes(1);
});

test.each(["mutation", "replacement"])(
  "%s after port disposal rejects retained weights; a later generation reloads provenance",
  async (change) => {
    const { root, path, hash, init, generation } = await fixture();
    const first = generation(1);
    const initial = await first.execute("init");
    await first.execute("dispose");
    if (change === "mutation") {
      await Bun.write(path, "synthetic weights B");
    } else {
      const replacement = join(root, "replacement.gguf");
      await Bun.write(replacement, "synthetic weights B");
      await rename(replacement, path);
    }
    expect(
      await first.execute("init").catch((cause: unknown) => cause)
    ).toMatchObject({
      reason: "stale_generation",
    });
    expect(hash).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledTimes(1);
    const current = await generation(2).execute("init");
    expect(current.response.result).not.toEqual(initial.response.result);
    expect(hash).toHaveBeenCalledTimes(2);
    expect(init).toHaveBeenCalledTimes(2);
  }
);

test("artifact mutation during hashing never seeds cached provenance or starts a load", async () => {
  const { path, hash, originalHash, init, generation } = await fixture();
  hash.mockImplementationOnce(async (artifact) => {
    const fingerprint = await originalHash(artifact);
    await Bun.write(path, "synthetic changed during hash");
    return fingerprint;
  });
  expect(
    await generation(1)
      .execute("init")
      .catch((cause: unknown) => cause)
  ).toMatchObject({
    reason: "stale_generation",
  });
  expect(init).toHaveBeenCalledTimes(0);
  expect((await generation(2).execute("init")).response.result.ok).toBe(true);
  expect(hash).toHaveBeenCalledTimes(2);
});

test("artifact mutation during a recreated port load cannot publish the retained fingerprint", async () => {
  const { path, hash, init, generation } = await fixture();
  const first = generation(1);
  await first.execute("init");
  await first.execute("dispose");
  init.mockImplementationOnce(async () => {
    await Bun.write(path, "synthetic changed during load");
    return { ok: true, value: undefined };
  });
  expect(
    await first.execute("init").catch((cause: unknown) => cause)
  ).toMatchObject({
    reason: "stale_generation",
  });
  expect(hash).toHaveBeenCalledTimes(1);
  expect((await generation(2).execute("init")).response.result.ok).toBe(true);
  expect(hash).toHaveBeenCalledTimes(2);
});

test("mutation during lazy inference discards the completion before delivery", async () => {
  const { path, model, generation } = await fixture();
  const embedding = spyOn(
    NodeLlamaCppEmbedding.prototype,
    "embed"
  ).mockImplementation(async () => {
    await Bun.write(path, "synthetic changed during inference");
    return { ok: true, value: [1, 0, 0] };
  });
  restores.push(() => embedding.mockRestore());
  const { owner } = generation(1);
  const result = await owner
    .execute({
      version: 1,
      generation: 1,
      requestId: 1,
      modelId: model.id,
      op: "embed",
      text: "unchanged input",
    })
    .catch((cause: unknown) => cause);
  expect(result).toMatchObject({ reason: "stale_generation" });
});
