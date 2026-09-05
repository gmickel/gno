import type { LlamaModel } from "node-llama-cpp";

/** Owned-process instrumentation only; never install in a user's resident service. */
// Bun has no synchronous write API for termination-safe capture sidecars.
import { writeFileSync } from "node:fs";
import { z } from "zod";

import type { AcceptanceManifest } from "./manifest";

import { RetrievalTraceSession } from "../../src/core/retrieval-trace-session";
import { ModelCache } from "../../src/llm/cache";
import { NodeLlamaCppEmbedding } from "../../src/llm/nodeLlamaCpp/embedding";
import { NodeLlamaCppGeneration } from "../../src/llm/nodeLlamaCpp/generation";
import { ModelManager } from "../../src/llm/nodeLlamaCpp/lifecycle";
import { NodeLlamaCppRerank } from "../../src/llm/nodeLlamaCpp/rerank";

export {
  captureArguments,
  exactJson,
  type NativeCapture,
} from "./capture-contract";
import {
  captureArguments,
  hashFile,
  captureContextArguments,
  captureContextModelArguments,
  exactJson,
  type NativeCapture,
} from "./capture-contract";
let active = false;

export function installNativeCapture(
  runId: string,
  pins: AcceptanceManifest["models"],
  onUpdate?: (capture: NativeCapture) => void
): {
  capture: NativeCapture;
  restore: () => void;
} {
  if (active) throw new Error("Native acceptance capture already active");
  active = true;
  const capture: NativeCapture = {
    runId,
    kind: "native",
    modelInputs: [],
    modelOutputs: [],
    backends: [],
    models: [],
    capabilities: [],
    errors: [],
  };
  const publish = () => onUpdate?.(capture);
  const restores: (() => void)[] = [];
  function replace<T extends object, K extends keyof T>(
    object: T,
    key: K,
    value: T[K]
  ): void {
    const previous = object[key];
    object[key] = value;
    restores.push(() => {
      object[key] = previous;
    });
  }
  const ensure = ModelCache.prototype.ensureModel;
  replace(
    ModelCache.prototype,
    "ensureModel",
    async function (this: ModelCache, uri, type, _policy, progress) {
      const pin = pins.find((item) => item.id === uri);
      if (!pin) throw new Error(`Unpinned model requested: ${uri}`);
      if (pin.tokenizerSha256 !== pin.sha256)
        throw new Error(
          `Unsupported tokenizer identity: GGUF containing-artifact SHA256 required for ${uri}`
        );
      const result = await ensure.call(
        this,
        uri,
        type,
        { offline: true, allowDownload: false },
        progress
      );
      if (!result.ok) {
        capture.errors.push(result.error.message);
        publish();
        return result;
      }
      const sha256 = await hashFile(result.value);
      if (sha256 !== pin.sha256) {
        const error = new Error(`Cached model hash mismatch: ${uri}`);
        capture.errors.push(error.message);
        publish();
        throw error;
      }
      if (!capture.models.some((model) => model.id === uri))
        capture.models.push({ id: uri, sha256 });
      publish();
      return result;
    }
  );
  const llama = ModelManager.prototype.getLlama;
  replace(
    ModelManager.prototype,
    "getLlama",
    async function (this: ModelManager) {
      const result = await llama.call(this);
      const backend = String(result.gpu);
      if (!capture.backends.includes(backend)) capture.backends.push(backend);
      publish();
      return result;
    }
  );
  const tappedModels = new WeakSet<object>();
  const loadModel = ModelManager.prototype.loadModel;
  replace(
    ModelManager.prototype,
    "loadModel",
    async function (this: ModelManager, ...args) {
      // In the worker, ModelCache is parent-only. Verify the actual load path here.
      const [path, uri] = args;
      const pin = pins.find((item) => item.id === uri);
      if (!pin || pin.tokenizerSha256 !== pin.sha256)
        throw new Error(`Unpinned model/tokenizer requested: ${uri}`);
      const sha256 = await hashFile(path);
      if (sha256 !== pin.sha256)
        throw new Error(`Cached model hash mismatch: ${uri}`);
      const result = await loadModel.apply(this, args);
      if (result.ok && !capture.models.some((model) => model.id === uri))
        capture.models.push({ id: uri, sha256 });
      publish();
      if (!result.ok || tappedModels.has(result.value.model as object))
        return result;
      const model = result.value.model as LlamaModel;
      tappedModels.add(model);
      function contextEvent(method: string, args: unknown[]) {
        const event: NonNullable<NativeCapture["contextEvents"]>[number] = {
          modelId: result.ok ? result.value.uri : uri,
          method,
          arguments: captureContextArguments(args),
        };
        (capture.contextEvents ??= []).push(event);
        publish();
        return event;
      }
      const createContext = model.createContext;
      replace(model, "createContext", async function (...contextArgs) {
        const event = contextEvent("createContext", contextArgs);
        const context = await createContext.apply(model, contextArgs);
        event.result = exactJson({ contextSize: context.contextSize });
        publish();
        return context;
      });
      const createRanking = model.createRankingContext;
      replace(model, "createRankingContext", async function (...contextArgs) {
        contextEvent("createRankingContext", contextArgs);
        return createRanking.apply(model, contextArgs);
      });
      const tokenize = model.tokenize;
      replace(model, "tokenize", ((
        ...tokenArgs: Parameters<LlamaModel["tokenize"]>
      ) => {
        const event = contextEvent("tokenize", tokenArgs);
        const tokens = tokenize.apply(model, tokenArgs);
        event.result = exactJson(Array.from(tokens));
        publish();
        return tokens;
      }) as LlamaModel["tokenize"]);
      const create = model.createEmbeddingContext;
      replace(
        model,
        "createEmbeddingContext",
        async function (this: LlamaModel, ...contextArgs) {
          contextEvent("createEmbeddingContext", contextArgs);
          const context = await create.apply(this, contextArgs);
          const embed = context.getEmbeddingFor;
          replace(context, "getEmbeddingFor", async function (...input) {
            capture.modelInputs.push({
              role: "embedding",
              modelId: result.value.uri,
              input: {
                nativeMethod: "getEmbeddingFor",
                context: captureArguments(
                  captureContextModelArguments(contextArgs)
                ),
                arguments: captureArguments(input),
              },
            });
            publish();
            return embed.apply(context, input);
          });
          return context;
        }
      );
      return result;
    }
  );
  const capability = RetrievalTraceSession.prototype.recordCapability;
  replace(
    RetrievalTraceSession.prototype,
    "recordCapability",
    function (this: RetrievalTraceSession, name, status, reasonCode, run) {
      capture.capabilities.push({
        capability: name,
        status,
        ...(reasonCode === undefined ? {} : { reasonCode }),
      });
      publish();
      return capability.call(this, name, status, reasonCode, run);
    }
  );
  function record(
    role: "embedding" | "reranking" | "generation",
    modelId: string,
    args: unknown[]
  ): void {
    capture.modelInputs.push({ role, modelId, input: captureArguments(args) });
    publish();
  }
  const embed = NodeLlamaCppEmbedding.prototype.embed;
  replace(
    NodeLlamaCppEmbedding.prototype,
    "embed",
    async function (this: NodeLlamaCppEmbedding, ...args) {
      record("embedding", this.modelUri, args.slice(0, 1));
      const output = await embed.apply(this, args);
      capture.modelOutputs.push(structuredClone(output));
      if (!output.ok) capture.errors.push(output.error.message);
      publish();
      return output;
    }
  );
  const batch = NodeLlamaCppEmbedding.prototype.embedBatch;
  replace(
    NodeLlamaCppEmbedding.prototype,
    "embedBatch",
    async function (this: NodeLlamaCppEmbedding, ...args) {
      record("embedding", this.modelUri, args.slice(0, 1));
      const output = await batch.apply(this, args);
      capture.modelOutputs.push(structuredClone(output));
      if (!output.ok) capture.errors.push(output.error.message);
      publish();
      return output;
    }
  );
  const rerank = NodeLlamaCppRerank.prototype.rerank;
  replace(
    NodeLlamaCppRerank.prototype,
    "rerank",
    async function (this: NodeLlamaCppRerank, ...args) {
      record("reranking", this.modelUri, args.slice(0, 2));
      const output = await rerank.apply(this, args);
      capture.modelOutputs.push(structuredClone(output));
      if (!output.ok) capture.errors.push(output.error.message);
      publish();
      return output;
    }
  );
  const generate = NodeLlamaCppGeneration.prototype.generate;
  replace(
    NodeLlamaCppGeneration.prototype,
    "generate",
    async function (this: NodeLlamaCppGeneration, ...args) {
      // GenParams stays exact; the third argument owns execution, not model input.
      record("generation", this.modelUri, args.slice(0, 2));
      const output = await generate.apply(this, args);
      capture.modelOutputs.push(structuredClone(output));
      if (!output.ok) capture.errors.push(output.error.message);
      publish();
      return output;
    }
  );
  let restored = false;
  return {
    capture,
    restore: () => {
      if (restored) return;
      restored = true;
      for (const restore of restores.reverse()) restore();
      active = false;
    },
  };
}

// Bun --preload runs this inside the same owned process as CLI/serve/MCP.
const sidecar = process.env.GNO_ACCEPTANCE_CAPTURE;
if (sidecar) {
  const input = z
    .object({
      runId: z.string(),
      models: z.array(
        z.object({
          role: z.enum(["embedding", "reranking", "generation"]),
          id: z.string(),
          sha256: z.string(),
          tokenizerSha256: z.string(),
        })
      ),
    })
    .parse(await Bun.file(`${sidecar}.request.json`).json());
  const session = installNativeCapture(input.runId, input.models, (capture) =>
    writeFileSync(sidecar, JSON.stringify(capture), { mode: 0o600 })
  );
  process.on("exit", () => {
    // Bun.write is asynchronous; exit hooks require the native synchronous file API.
    writeFileSync(sidecar, JSON.stringify(session.capture), { mode: 0o600 });
    session.restore();
  });
}
