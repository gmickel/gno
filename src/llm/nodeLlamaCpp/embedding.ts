/**
 * Embedding port implementation using node-llama-cpp.
 *
 * @module src/llm/nodeLlamaCpp/embedding
 */

import type { EmbeddingPort, LlmResult } from "../types";
import type { ModelManager } from "./lifecycle";

import { inferenceFailedError } from "../errors";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

// LlamaModel type from node-llama-cpp
type LlamaModel = Awaited<
  ReturnType<
    Awaited<ReturnType<typeof import("node-llama-cpp").getLlama>>["loadModel"]
  >
>;

type LlamaEmbeddingContext = Awaited<
  ReturnType<LlamaModel["createEmbeddingContext"]>
>;
type LlamaEmbedding = Awaited<
  ReturnType<LlamaEmbeddingContext["getEmbeddingFor"]>
>;

type Llama = Awaited<ReturnType<typeof import("node-llama-cpp").getLlama>>;

interface EmbeddingWorker {
  context: LlamaEmbeddingContext;
  pending: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// Aim for a small pool so CPU-only runs can exploit parallel contexts without
// multiplying RAM usage too aggressively. Additional contexts fall back
// gracefully if memory is tight.
const MAX_EMBEDDING_CONTEXTS = 4;
const TARGET_CORES_PER_EMBEDDING_CONTEXT = 4;

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

export class NodeLlamaCppEmbedding implements EmbeddingPort {
  private workers: EmbeddingWorker[] = [];
  private contextsPromise: Promise<LlmResult<LlamaEmbeddingContext[]>> | null =
    null;
  private dims: number | null = null;
  private readonly manager: ModelManager;
  readonly modelUri: string;
  private readonly modelPath: string;

  constructor(manager: ModelManager, modelUri: string, modelPath: string) {
    this.manager = manager;
    this.modelUri = modelUri;
    this.modelPath = modelPath;
  }

  async init(): Promise<LlmResult<void>> {
    const contexts = await this.getContexts();
    if (!contexts.ok) {
      return contexts;
    }
    return { ok: true, value: undefined };
  }

  async embed(text: string): Promise<LlmResult<number[]>> {
    const contexts = await this.getContexts();
    if (!contexts.ok) {
      return contexts;
    }

    try {
      const embedding = await this.runOnWorker((worker) =>
        worker.context.getEmbeddingFor(text)
      );
      const vector = Array.from(embedding.vector) as number[];

      // Cache dimensions on first call
      if (this.dims === null) {
        this.dims = vector.length;
      }

      return { ok: true, value: vector };
    } catch (e) {
      return { ok: false, error: inferenceFailedError(this.modelUri, e) };
    }
  }

  async embedBatch(texts: string[]): Promise<LlmResult<number[][]>> {
    const contexts = await this.getContexts();
    if (!contexts.ok) {
      return contexts;
    }

    if (texts.length === 0) {
      return { ok: true, value: [] };
    }

    try {
      const settled = await Promise.allSettled(
        texts.map((text) =>
          this.runOnWorker((worker) => worker.context.getEmbeddingFor(text))
        )
      );

      const firstRejection = settled.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected"
      );
      if (firstRejection) {
        return {
          ok: false,
          error: inferenceFailedError(this.modelUri, firstRejection.reason),
        };
      }

      const allResults = (
        settled as Array<PromiseFulfilledResult<LlamaEmbedding>>
      ).map((result) => Array.from(result.value.vector) as number[]);

      // Cache dimensions from first result
      const firstResult = allResults[0];
      if (this.dims === null && firstResult !== undefined) {
        this.dims = firstResult.length;
      }

      return { ok: true, value: allResults };
    } catch (e) {
      return { ok: false, error: inferenceFailedError(this.modelUri, e) };
    }
  }

  dimensions(): number {
    if (this.dims === null) {
      throw new Error("Call init() or embed() first to initialize dimensions");
    }
    return this.dims;
  }

  async dispose(): Promise<void> {
    this.contextsPromise = null;
    const workers = this.workers;
    this.workers = [];

    for (const worker of workers) {
      try {
        await worker.context.dispose();
      } catch {
        // Ignore disposal errors
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Private
  // ───────────────────────────────────────────────────────────────────────────

  private async runOnWorker<T>(
    task: (worker: EmbeddingWorker) => Promise<T>
  ): Promise<T> {
    const worker = this.getLeastBusyWorker();
    worker.pending += 1;
    try {
      return await task(worker);
    } finally {
      worker.pending -= 1;
    }
  }

  private getLeastBusyWorker(): EmbeddingWorker {
    const firstWorker = this.workers[0];
    if (!firstWorker) {
      throw new Error("Embedding context not initialized");
    }

    let bestWorker = firstWorker;
    for (const worker of this.workers) {
      if (worker.pending < bestWorker.pending) {
        bestWorker = worker;
      }
    }
    return bestWorker;
  }

  private getContexts(): Promise<LlmResult<LlamaEmbeddingContext[]>> {
    if (this.workers.length > 0) {
      return Promise.resolve({
        ok: true,
        value: this.workers.map((worker) => worker.context),
      });
    }

    if (this.contextsPromise) {
      return this.contextsPromise;
    }

    this.contextsPromise = this.createContexts();
    return this.contextsPromise;
  }

  private resolveTargetPoolSize(llama: Llama): number {
    if (llama.gpu !== false) {
      return 1;
    }

    const cpuMathCores = Math.max(1, llama.cpuMathCores);
    return Math.max(
      1,
      Math.min(
        MAX_EMBEDDING_CONTEXTS,
        Math.ceil(cpuMathCores / TARGET_CORES_PER_EMBEDDING_CONTEXT)
      )
    );
  }

  private async createContexts(): Promise<LlmResult<LlamaEmbeddingContext[]>> {
    const model = await this.manager.loadModel(
      this.modelPath,
      this.modelUri,
      "embed"
    );
    if (!model.ok) {
      this.contextsPromise = null;
      return model;
    }

    try {
      const llamaModel = model.value.model as LlamaModel;
      const llama = await this.manager.getLlama();
      const targetPoolSize = this.resolveTargetPoolSize(llama);
      const contextOptions = llama.gpu === false ? { threads: 0 } : undefined;
      const contexts: LlamaEmbeddingContext[] = [];

      for (let i = 0; i < targetPoolSize; i += 1) {
        try {
          const context =
            await llamaModel.createEmbeddingContext(contextOptions);
          contexts.push(context);
        } catch (error) {
          if (contexts.length === 0) {
            this.contextsPromise = null;
            return {
              ok: false,
              error: inferenceFailedError(this.modelUri, error),
            };
          }
          break;
        }
      }

      this.workers = contexts.map((context) => ({ context, pending: 0 }));

      const size = llamaModel.embeddingVectorSize;
      if (this.dims === null && typeof size === "number" && size > 0) {
        this.dims = size;
      }

      return { ok: true, value: contexts };
    } catch (e) {
      this.contextsPromise = null;
      return { ok: false, error: inferenceFailedError(this.modelUri, e) };
    }
  }
}
