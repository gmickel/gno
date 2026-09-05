import { expect, test } from "bun:test";
// Bun has no temporary-directory or canonical-path API.
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NativeDispatcher } from "../../src/llm/native-worker/dispatcher";
import { safeRm } from "../helpers/cleanup";

test("dispatcher responses include released leases after success, wire error and thrown provenance failure", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "gno-dispatcher-stats-"))
  );
  const path = join(root, "synthetic.gguf");
  await Bun.write(path, "synthetic model identity");
  const dispatcher = new NativeDispatcher({
    generation: 1,
    models: [
      { id: "gen", type: "gen", modelUri: "file:/synthetic.gguf", path },
    ],
    loadTimeout: 1000,
    inferenceTimeout: 1000,
    warmModelTtl: 0,
  });
  const envelope = { version: 1 as const, generation: 1, modelId: "gen" };
  try {
    // Generation metadata initialization constructs the real port without loading weights.
    const initialized = await dispatcher.execute({
      ...envelope,
      requestId: 1,
      op: "init",
    });
    expect(initialized.response.result).toEqual({
      ok: true,
      value: { structuredOutput: "json_schema" },
    });
    expect(initialized.response.lifecycle).toMatchObject({
      activeLeases: 0,
      leaseAcquisitions: 1,
      leaseReleases: 1,
      loadAttempts: 0,
    });
    // An embedding request sent to a generation port produces a real wire error.
    const failed = await dispatcher.execute({
      ...envelope,
      requestId: 2,
      op: "embed",
      text: "not evaluated",
    });
    expect(failed.response.result).toMatchObject({
      ok: false,
      error: { code: "INFERENCE_FAILED" },
    });
    expect(failed.response.lifecycle).toMatchObject({
      activeLeases: 0,
      leaseAcquisitions: 2,
      leaseReleases: 2,
      loadAttempts: 0,
    });
    await Bun.write(path, "changed model identity with different length");
    const failure = await dispatcher
      .execute({ ...envelope, requestId: 3, op: "init" })
      .then(
        () => null,
        (error: unknown) => error
      );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("stale_generation");
    const disposed = await dispatcher.execute({
      ...envelope,
      requestId: 4,
      op: "dispose",
    });
    expect(disposed.response.lifecycle).toMatchObject({
      activeLeases: 0,
      leaseAcquisitions: 4,
      leaseReleases: 4,
      loadAttempts: 0,
    });
    expect(disposed.response.result).toEqual({ ok: true, value: null });
  } finally {
    await dispatcher.dispose();
    await safeRm(root);
  }
});
