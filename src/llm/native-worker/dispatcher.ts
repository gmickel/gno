// Bun has no realpath API; canonical identity must be rechecked in the child.
import { realpath } from "node:fs/promises";

import type { LlmResult } from "../types";
import type { ApprovedModel, NativeRequest, NativeResponse } from "./protocol";
import type { NativeRuntimeConfig } from "./runtime-config";

import { NodeLlamaCppEmbedding } from "../nodeLlamaCpp/embedding";
import { NodeLlamaCppGeneration } from "../nodeLlamaCpp/generation";
import { ModelManager } from "../nodeLlamaCpp/lifecycle";
import { NodeLlamaCppRerank } from "../nodeLlamaCpp/rerank";
import {
  fileIdentity,
  fingerprintModel,
  fingerprintRuntime,
} from "./embedding-identity";
import { NativeWorkerError } from "./errors";
import { splitEmbeddingRequest } from "./protocol";
import { wireError } from "./runtime-config";

type Port = NodeLlamaCppEmbedding | NodeLlamaCppGeneration | NodeLlamaCppRerank;

/** Imported only by the native child. No discovery, downloads or parent state. */
export class NativeDispatcher {
  private readonly manager: ModelManager;
  private readonly ports = new Map<string, Port>();
  private readonly files = new Map<
    string,
    { identity: string; fingerprint?: string }
  >();
  // The process owns expiry. Disable independent model timers while it is alive.
  private readonly lease;

  constructor(private readonly config: NativeRuntimeConfig) {
    this.manager = new ModelManager({
      activePreset: "native-worker",
      presets: [],
      expandContextSize: 2048,
      loadTimeout: config.loadTimeout,
      inferenceTimeout: config.inferenceTimeout,
      warmModelTtl: config.warmModelTtl,
    });
    this.lease = this.manager.acquireLease();
  }

  private async port(model: ApprovedModel): Promise<Port> {
    if (
      (await realpath(model.path)) !== model.path ||
      !(await Bun.file(model.path).exists())
    ) {
      throw new NativeWorkerError("protocol");
    }
    const existing = this.ports.get(model.id);
    const identity = await fileIdentity(model.path);
    if (existing && this.files.get(model.id)?.identity !== identity)
      throw new NativeWorkerError("stale_generation");
    if (existing) return existing;
    const fingerprint =
      model.type === "embed" ? await fingerprintModel(model.path) : undefined;
    if (identity !== (await fileIdentity(model.path)))
      throw new NativeWorkerError("stale_generation");
    const Constructor =
      model.type === "embed"
        ? NodeLlamaCppEmbedding
        : model.type === "rerank"
          ? NodeLlamaCppRerank
          : NodeLlamaCppGeneration;
    const port = new Constructor(this.manager, model.modelUri, model.path);
    this.ports.set(model.id, port);
    this.files.set(model.id, { identity, fingerprint });
    return port;
  }

  async execute(
    request: NativeRequest
  ): Promise<{ response: NativeResponse; activity: boolean }> {
    const model = this.config.models.find(
      (entry) => entry.id === request.modelId
    );
    if (!model) throw new NativeWorkerError("protocol");
    const before = this.manager.getLifecycleStats().loadAttempts;
    const result = await this.run(request, model);
    return {
      response: {
        version: 1,
        generation: request.generation,
        requestId: request.requestId,
        op: request.op,
        lifecycle: this.manager.getLifecycleStats(),
        result: result.ok
          ? result
          : { ok: false, error: wireError(result.error) },
      },
      activity:
        this.manager.getLifecycleStats().loadAttempts !== before ||
        !["init", "dispose"].includes(request.op),
    };
  }

  private async run(
    request: NativeRequest,
    model: ApprovedModel
  ): Promise<
    LlmResult<Extract<NativeResponse["result"], { ok: true }>["value"]>
  > {
    if (request.op === "dispose") {
      await this.ports.get(model.id)?.dispose();
      this.ports.delete(model.id);
      return { ok: true, value: null };
    }
    const port = await this.port(model);
    switch (request.op) {
      case "init": {
        if (port instanceof NodeLlamaCppEmbedding) {
          const result = await port.init();
          if (!result.ok) return result;
          const file = this.files.get(model.id);
          if (
            !file?.fingerprint ||
            file.identity !== (await fileIdentity(model.path))
          )
            throw new NativeWorkerError("stale_generation");
          const settings = port.getContextIdentity();
          const llama = await this.manager.getLlama();
          return {
            ok: true,
            value: {
              dimensions: port.dimensions(),
              structuredOutput: "none",
              embeddingIdentity: {
                contextSize: settings.contextSize,
                truncationPolicy: settings.truncationPolicy,
                modelFingerprint: file.fingerprint,
                runtimeFingerprint: fingerprintRuntime({
                  ...settings,
                  gpu: llama.gpu,
                  cpuMathCores: llama.cpuMathCores,
                }),
              },
            },
          };
        }
        return {
          ok: true,
          value: {
            structuredOutput:
              port instanceof NodeLlamaCppGeneration ? "json_schema" : "none",
          },
        };
      }
      case "embed":
        if (port instanceof NodeLlamaCppEmbedding)
          return port.embed(request.text);
        break;
      case "embedBatch":
        if (port instanceof NodeLlamaCppEmbedding) {
          const vectors: number[][] = [];
          for (const texts of splitEmbeddingRequest(request)) {
            const result = await port.embedBatch(texts);
            if (!result.ok) return result;
            for (const vector of result.value) vectors.push(vector);
          }
          return { ok: true, value: vectors };
        }
        break;
      case "generate":
        if (port instanceof NodeLlamaCppGeneration)
          return port.generate(request.prompt, request.params);
        break;
      case "rerank":
        if (port instanceof NodeLlamaCppRerank)
          return port.rerank(request.query, request.documents);
        break;
      default:
        break;
    }
    throw new NativeWorkerError("protocol");
  }

  async dispose(): Promise<void> {
    const results = await Promise.allSettled(
      Array.from(this.ports.values(), (port) => port.dispose())
    );
    this.ports.clear();
    this.files.clear();
    this.lease.release();
    await this.manager.disposeAll();
    if (results.some((result) => result.status === "rejected"))
      throw new NativeWorkerError("exited");
  }
}
