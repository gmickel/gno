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

type Llama = Awaited<ReturnType<typeof import("node-llama-cpp").getLlama>>;

interface EmbeddingWorker {
  context: LlamaEmbeddingContext;
  pending: number;
}

interface TokenizingModel {
  trainContextSize?: number;
  tokenize(text: string): readonly number[];
  detokenize(tokens: readonly number[]): string;
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
  private lifecycleVersion = 0;
  private dims: number | null = null;
  private llamaModel: TokenizingModel | null = null;
  private warnedSingleTruncation = false;
  private warnedBatchTruncation = false;
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
      const prepared = this.truncateForEmbedding(text, "single");
      if (!prepared.ok) {
        return { ok: false, error: prepared.error };
      }
      const embedding = await this.runOnWorker((worker) =>
        worker.context.getEmbeddingFor(prepared.value.text)
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
      const preparedTexts: string[] = [];
      for (const text of texts) {
        const prepared = this.truncateForEmbedding(text, "batch");
        if (!prepared.ok) {
          return { ok: false, error: prepared.error };
        }
        preparedTexts.push(prepared.value.text);
      }

      const allResults = Array.from(
        { length: texts.length },
        () => [] as number[]
      );
      let nextIndex = 0;

      const settled = await Promise.allSettled(
        this.workers.map(async (worker) => {
          while (true) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= preparedTexts.length) {
              return;
            }

            const embedding = await this.runOnSpecificWorker(
              worker,
              (current) =>
                current.context.getEmbeddingFor(preparedTexts[index] as string)
            );
            allResults[index] = Array.from(embedding.vector) as number[];
          }
        })
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
    this.lifecycleVersion += 1;
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
    return this.runOnSpecificWorker(worker, task);
  }

  private async runOnSpecificWorker<T>(
    worker: EmbeddingWorker,
    task: (worker: EmbeddingWorker) => Promise<T>
  ): Promise<T> {
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

  private resolveThreadsPerContext(llama: Llama, poolSize: number): number {
    if (llama.gpu !== false) {
      return 0;
    }

    return Math.max(1, Math.floor(Math.max(1, llama.cpuMathCores) / poolSize));
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
      this.llamaModel = llamaModel as TokenizingModel;
      const llama = await this.manager.getLlama();
      const lifecycleVersion = this.lifecycleVersion;
      const targetPoolSize = this.resolveTargetPoolSize(llama);
      const threadsPerContext = this.resolveThreadsPerContext(
        llama,
        targetPoolSize
      );
      const contextOptions =
        llama.gpu === false ? { threads: threadsPerContext } : undefined;
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

      if (lifecycleVersion !== this.lifecycleVersion) {
        for (const context of contexts) {
          try {
            await context.dispose();
          } catch {
            // Ignore disposal errors
          }
        }
        return {
          ok: false,
          error: inferenceFailedError(
            this.modelUri,
            new Error("Embedding context disposed during initialization")
          ),
        };
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

  private truncateForEmbedding(
    text: string,
    mode: "single" | "batch"
  ): LlmResult<{ text: string }> {
    const model = this.llamaModel;
    const rawLimit =
      typeof model?.trainContextSize === "number" &&
      Number.isFinite(model.trainContextSize) &&
      model.trainContextSize > 0
        ? Math.floor(model.trainContextSize)
        : undefined;
    if (!model || rawLimit === undefined) {
      return { ok: true, value: { text } };
    }

    const limit = Math.max(1, rawLimit - 4);
    try {
      const tokens = model.tokenize(text);
      if (tokens.length <= limit) {
        return { ok: true, value: { text } };
      }

      const truncatedText = model.detokenize(tokens.slice(0, limit));
      const shouldWarn =
        mode === "single"
          ? !this.warnedSingleTruncation
          : !this.warnedBatchTruncation;
      if (shouldWarn) {
        if (mode === "single") {
          this.warnedSingleTruncation = true;
        } else {
          this.warnedBatchTruncation = true;
        }
        console.warn(
          `[llama] Truncated embedding input from ${tokens.length} to ${limit} tokens`
        );
      }
      return { ok: true, value: { text: truncatedText } };
    } catch (error) {
      return { ok: false, error: inferenceFailedError(this.modelUri, error) };
    }
  }
}
