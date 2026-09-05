import type { NativeEvaluationOptions } from "../native-worker/evaluation";
import type { LlmResult, RerankPort, RerankScore } from "../types";
/**
 * Rerank port implementation using node-llama-cpp.
 *
 * @module src/llm/nodeLlamaCpp/rerank
 */
import type { ModelManager } from "./lifecycle";

import { inferenceFailedError } from "../errors";
import { checkEvaluation, startEvaluation } from "../native-worker/evaluation";
import { getRerankCapacity } from "./rerank-capacity";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type LlamaModel = Awaited<
  ReturnType<
    Awaited<ReturnType<typeof import("node-llama-cpp").getLlama>>["loadModel"]
  >
>;

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

export class NodeLlamaCppRerank implements RerankPort {
  private readonly manager: ModelManager;
  readonly modelUri: string;
  private readonly modelPath: string;

  private context: Awaited<
    ReturnType<LlamaModel["createRankingContext"]>
  > | null = null;
  private contextModel: LlamaModel | null = null;
  private contextSize: number | undefined;
  private contextConfiguration: string | undefined;
  private pending: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(manager: ModelManager, modelUri: string, modelPath: string) {
    this.manager = manager;
    this.modelUri = modelUri;
    this.modelPath = modelPath;
  }

  async rerank(
    query: string,
    documents: string[],
    options?: NativeEvaluationOptions
  ): Promise<LlmResult<RerankScore[]>> {
    if (documents.length === 0) {
      return { ok: true, value: [] };
    }

    if (this.disposed) {
      return {
        ok: false,
        error: inferenceFailedError(
          this.modelUri,
          new Error("Rerank port is disposed")
        ),
      };
    }
    // Snapshot caller-owned input before waiting for a different capacity batch.
    const input = [...documents];
    const operation = this.pending.then(() =>
      this.score(query, input, options)
    );
    this.pending = operation.then(
      () => {},
      () => {}
    );
    return operation;
  }

  private async score(
    query: string,
    documents: string[],
    options?: NativeEvaluationOptions
  ): Promise<LlmResult<RerankScore[]>> {
    const lease = this.manager.acquireLease();
    try {
      checkEvaluation(options);
      const model = await this.manager.loadModel(
        this.modelPath,
        this.modelUri,
        "rerank",
        options?.signal
      );
      if (!model.ok) return model;
      checkEvaluation(options);
      const llamaModel = model.value.model as LlamaModel;
      if (llamaModel.disposed) throw new Error("Rerank model is disposed");
      const capacity = getRerankCapacity(llamaModel, query, documents);
      const contextSize =
        capacity.kind === "sized" ? capacity.contextSize : undefined;
      const configuration = JSON.stringify([
        llamaModel.fileInfo.metadata.general?.architecture,
        llamaModel.fileInfo.metadata.tokenizer?.["chat_template.rerank"],
        llamaModel.vocabularyType,
        llamaModel.trainContextSize,
      ]);
      if (
        this.contextConfiguration !== configuration ||
        this.contextModel !== llamaModel ||
        this.contextSize !== contextSize ||
        this.context?.disposed
      ) {
        await this.releaseContext();
      }
      if (!this.context) {
        this.context = await llamaModel.createRankingContext({
          ...(contextSize === undefined ? {} : { contextSize }),
          createSignal: options?.signal,
        });
        this.contextModel = llamaModel;
        this.contextSize = contextSize;
        this.contextConfiguration = configuration;
      }
      if (this.context.disposed || llamaModel.disposed)
        throw new Error("Rerank context is disposed");
      // Build index map for O(1) lookups (handles duplicates correctly)
      const indexMap = new Map<string, number[]>();
      for (let i = 0; i < documents.length; i += 1) {
        const doc = documents[i] as string; // Guaranteed by loop bounds
        const indices = indexMap.get(doc) ?? [];
        indices.push(i);
        indexMap.set(doc, indices);
      }

      startEvaluation(options);
      const ranked = await this.context.rankAndSort(query, documents);
      checkEvaluation(options);
      if (ranked.length !== documents.length)
        throw new Error("Rerank returned incomplete scores");

      // Convert to RerankScore format with O(1) index lookup
      const scores: RerankScore[] = ranked.map((item, rank) => {
        const indices = indexMap.get(item.document) ?? [];
        // Shift to handle duplicates (each duplicate gets next index)
        const index = indices.shift();
        if (index === undefined || !Number.isFinite(item.score)) {
          throw new Error("Rerank returned invalid candidate scores");
        }
        return {
          index,
          score: item.score,
          rank: rank + 1,
        };
      });

      return { ok: true, value: scores };
    } catch (e) {
      await this.releaseContext();
      return { ok: false, error: inferenceFailedError(this.modelUri, e) };
    } finally {
      lease.release();
    }
  }

  private async releaseContext(): Promise<void> {
    const context = this.context;
    this.context = null;
    this.contextModel = null;
    this.contextSize = undefined;
    this.contextConfiguration = undefined;
    if (context && !context.disposed) {
      await context.dispose().catch(() => {
        // A failed native context must never be reused.
      });
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.pending;
    const lease = this.manager.acquireLease();
    try {
      await this.releaseContext();
    } finally {
      lease.release();
    }
  }
}
