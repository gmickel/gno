import type { SessionBootstrap, SessionCommand } from "./session-driver";

import { ModelCache } from "../../src/llm/cache";
/** Internal owned-child entrypoint. All product imports resolve in this snapshot. */
import { getModelConfig } from "../../src/llm/registry";
import { hashFile } from "./capture-contract";
import { createNativeAcceptanceSession } from "./native-adapter";
import { hasNativeWorker } from "./parent-capture";

const configPath = process.env.GNO_ACCEPTANCE_SESSION_CONFIG;
if (!configPath || !process.send)
  throw new Error("Acceptance session child requires owned IPC bootstrap");
const bootstrap = (await Bun.file(configPath).json()) as SessionBootstrap;
const { runId, manifest, init, requests, directory } = bootstrap;
const send = (message: object) =>
  process.send?.({ runId, pid: process.pid, ...message });
const startedAt = new Date().toISOString();
let session:
  | Awaited<ReturnType<typeof createNativeAcceptanceSession>>
  | undefined;
try {
  const preflightStart = performance.now();
  {
    const cache = new ModelCache(init.cacheDir);
    for (const model of manifest.models) {
      const type =
        model.role === "embedding"
          ? "embed"
          : model.role === "reranking"
            ? "rerank"
            : "gen";
      const result = await cache.ensureModel(model.id, type, {
        offline: true,
        allowDownload: false,
      });
      if (!result.ok) throw new Error(result.error.message);
      if (
        model.tokenizerSha256 !== model.sha256 ||
        (await hashFile(result.value)) !== model.sha256
      )
        throw new Error(`Cached model hash mismatch: ${model.id}`);
    }
  }
  const preflightMs = performance.now() - preflightStart;
  session = await createNativeAcceptanceSession(manifest, init, {
    directory,
    onChild: (event) => send({ childEvent: event, ok: true }),
  });
  const manager = (await hasNativeWorker())
    ? undefined
    : (await import("../../src/llm/nodeLlamaCpp/lifecycle")).getModelManager(
        getModelConfig(init.config)
      );
  let requestedModels: string[] = [];
  let busy = false;
  let sequence = 0;
  let closing = false;
  const state = () => {
    if (!manager) return session!.modelState();
    const lifecycle = manager.getLifecycleStats();
    const models = requestedModels.map((id) => ({
      id,
      loaded: manager.isLoaded(id),
    }));
    const loaded =
      lifecycle.loadedModels === 0
        ? false
        : models.length
          ? models.every((model) => model.loaded)
          : null;
    return { loaded, lifecycle, models };
  };
  process.on("message", async (input: unknown) => {
    const command = input as SessionCommand;
    if (
      command?.runId !== runId ||
      !Number.isSafeInteger(command.sequence) ||
      command.sequence !== sequence + 1 ||
      busy ||
      closing
    ) {
      send({
        sequence: command?.sequence,
        ok: false,
        error: "Invalid or overlapping session command",
      });
      return;
    }
    sequence = command.sequence;
    busy = true;
    try {
      let response: unknown;
      if (command.operation === "run") {
        const request = requests.find((item) => item.caseId === command.caseId);
        if (!request)
          throw new Error(`Unknown session case: ${command.caseId}`);
        const before = state();
        const result = await session!.run(request);
        requestedModels = [
          ...new Set(result.receipt.modelInputs.map((item) => item.modelId)),
        ];
        response = { result, before, after: state() };
      } else if (command.operation === "state") response = state();
      else if (command.operation === "close") {
        closing = true;
        await session!.close();
        response = { closed: true };
      } else throw new Error("Unknown session operation");
      const resultPath = `${directory}/${sequence}.reply.json.gz`;
      await Bun.write(
        resultPath,
        Bun.gzipSync(
          JSON.stringify({ runId, sequence, pid: process.pid, response })
        )
      );
      send({ sequence, ok: true, resultPath });
      if (closing) {
        process.disconnect?.();
        process.exit(0);
      }
    } catch (error) {
      send({
        sequence,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      // Any failed request ends the owned process; no poisoned session reuse.
      try {
        await session?.close();
      } finally {
        process.disconnect?.();
        process.exit(1);
      }
    } finally {
      busy = false;
    }
  });
  send({ ready: true, ok: true, startedAt, preflightMs, state: state() });
} catch (error) {
  send({
    ready: true,
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
  try {
    await session?.close();
  } finally {
    process.disconnect?.();
    process.exit(1);
  }
}
