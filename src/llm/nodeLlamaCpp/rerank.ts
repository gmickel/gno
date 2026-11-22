import type { Token } from "node-llama-cpp";

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
import { prepareRerankBatch } from "./rerank-capacity";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type LlamaModel = Awaited<
  ReturnType<
    Awaited<ReturnType<typeof import("node-llama-cpp").getLlama>>["loadModel"]
  >
>;
type LlamaRankingContext = Awaited<
  ReturnType<LlamaModel["createRankingContext"]>
>;

const RERANK_HYSTERESIS_MIN_TOKENS = 2048;
const DUAL_RERANK_MIN_CPU_CORES = 12;
const DUAL_RERANK_THREADS_PER_CONTEXT = 6;

interface NativeDirectRankingContext {
  _evaluateRankingForInput(input: Token[]): Promise<number>;
  _llamaContext?: { contextSize?: number };
}

function asDirectRankingContext(
  context: LlamaRankingContext
): NativeDirectRankingContext | null {
  const candidate = context as unknown as Partial<NativeDirectRankingContext>;
  return typeof candidate._evaluateRankingForInput === "function"
    ? (candidate as NativeDirectRankingContext)
    : null;
}

async function scoreUniqueWithContext(
  context: LlamaRankingContext,
  query: string,
  uniqueDocs: string[],
  pairTokens?: Token[][]
): Promise<number[]> {
  // Fast path for pinned node-llama-cpp@3.20.0 audited pairs: evaluate the
  // pre-built complete token sequences directly so neither static template
  // fragments, query, nor documents are re-tokenized during scoring.
  const direct = asDirectRankingContext(context);
  if (
    direct !== null &&
    pairTokens !== undefined &&
    pairTokens.length === uniqueDocs.length
  ) {
    const limit = direct._llamaContext?.contextSize;
    if (typeof limit === "number" && limit > 0) {
      let maxLen = 0;
      for (const tokens of pairTokens) {
        if (tokens.length > maxLen) maxLen = tokens.length;
      }
      if (maxLen > limit) {
        throw new Error(
          `The input lengths of some of the given documents exceed the context size. Try to increase the context size to at least ${maxLen + 1} or use another model that supports longer contexts.`
        );
      }
    }
    const raw = await Promise.all(
      pairTokens.map((tokens) => direct._evaluateRankingForInput(tokens))
    );
    if (raw.length !== uniqueDocs.length) {
      throw new Error("Rerank returned incomplete scores");
    }
    for (const score of raw) {
      if (!Number.isFinite(score)) {
        throw new Error("Rerank returned invalid candidate scores");
      }
    }
    return raw;
  }

  if (typeof context.rankAll === "function") {
    const raw = await context.rankAll(query, uniqueDocs);
    if (raw.length !== uniqueDocs.length) {
      throw new Error("Rerank returned incomplete scores");
    }
    for (const score of raw) {
      if (!Number.isFinite(score)) {
        throw new Error("Rerank returned invalid candidate scores");
      }
    }
    return raw;
  }
  // Fallback for test doubles that only implement rankAndSort.
  const ranked = await context.rankAndSort(query, uniqueDocs);
  if (ranked.length !== uniqueDocs.length) {
    throw new Error("Rerank returned incomplete scores");
  }
  const indexByDoc = new Map<string, number>();
  for (let i = 0; i < uniqueDocs.length; i += 1) {
    indexByDoc.set(uniqueDocs[i]!, i);
  }
  const scores = Array.from<number>({ length: uniqueDocs.length });
  for (const item of ranked) {
    const idx = indexByDoc.get(item.document);
    if (idx === undefined || !Number.isFinite(item.score)) {
      throw new Error("Rerank returned invalid candidate scores");
    }
    scores[idx] = item.score;
  }
  return scores;
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

export class NodeLlamaCppRerank implements RerankPort {
  private readonly manager: ModelManager;
  readonly modelUri: string;
  private readonly modelPath: string;

  private contexts: LlamaRankingContext[] = [];
  private contextModel: LlamaModel | null = null;
  private contextSize: number | undefined;
  private contextConfiguration: string | undefined;
  private contextPoolSize = 0;
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

  private contextSizeCompatible(needed: number | undefined): boolean {
    if (needed === undefined) {
      return this.contextSize === undefined;
    }
    return (
      this.contextSize !== undefined &&
      this.contextSize >= needed &&
      this.contextSize <= Math.max(RERANK_HYSTERESIS_MIN_TOKENS, needed * 2)
    );
  }

  private async resolveTargetPoolConfig(): Promise<{
    poolSize: number;
    threads?: number;
  }> {
    if (typeof this.manager.getLlama !== "function") {
      return { poolSize: 1 };
    }
    const llama = await this.manager.getLlama();
    if (
      llama.gpu === false &&
      llama.cpuMathCores >= DUAL_RERANK_MIN_CPU_CORES
    ) {
      return { poolSize: 2, threads: DUAL_RERANK_THREADS_PER_CONTEXT };
    }
    return { poolSize: 1 };
  }

  private async score(
    query: string,
    documents: string[],
    options?: NativeEvaluationOptions
  ): Promise<LlmResult<RerankScore[]>> {
    const lease = this.manager.acquireLease(this.modelUri);
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

      // Deduplicate identical documents before capacity estimation and neural scoring.
      const uniqueDocs: string[] = [];
      const uniqueIndexByDoc = new Map<string, number>();
      const docToUniqueIndex = Array.from<number>({ length: documents.length });
      for (let i = 0; i < documents.length; i += 1) {
        const doc = documents[i]!;
        let u = uniqueIndexByDoc.get(doc);
        if (u === undefined) {
          u = uniqueDocs.length;
          uniqueIndexByDoc.set(doc, u);
          uniqueDocs.push(doc);
        }
        docToUniqueIndex[i] = u;
      }

      const prepared = prepareRerankBatch(llamaModel, query, uniqueDocs);
      const { capacity, pairTokens } = prepared;
      const contextSize =
        capacity.kind === "sized" ? capacity.contextSize : undefined;
      const configuration = JSON.stringify([
        llamaModel.fileInfo.metadata.general?.architecture,
        llamaModel.fileInfo.metadata.tokenizer?.["chat_template.rerank"],
        llamaModel.vocabularyType,
        llamaModel.trainContextSize,
      ]);
      const poolConfig = await this.resolveTargetPoolConfig();
      const anyDisposed = this.contexts.some((ctx) => ctx.disposed);
      if (
        this.contextConfiguration !== configuration ||
        this.contextModel !== llamaModel ||
        this.contextPoolSize !== poolConfig.poolSize ||
        !this.contextSizeCompatible(contextSize) ||
        anyDisposed
      ) {
        await this.releaseContext();
      }
      if (this.contexts.length === 0) {
        const created: LlamaRankingContext[] = [];
        try {
          for (let i = 0; i < poolConfig.poolSize; i += 1) {
            const ctx = await llamaModel.createRankingContext({
              ...(contextSize === undefined ? {} : { contextSize }),
              ...(poolConfig.threads === undefined
                ? {}
                : { threads: poolConfig.threads }),
              createSignal: options?.signal,
            });
            created.push(ctx);
          }
        } catch (error) {
          await Promise.allSettled(
            created.map((ctx) => (!ctx.disposed ? ctx.dispose() : undefined))
          );
          throw error;
        }
        this.contexts = created;
        this.contextModel = llamaModel;
        this.contextSize = contextSize;
        this.contextConfiguration = configuration;
        this.contextPoolSize = poolConfig.poolSize;
      }
      if (this.contexts.some((ctx) => ctx.disposed) || llamaModel.disposed) {
        throw new Error("Rerank context is disposed");
      }

      startEvaluation(options);
      let uniqueScores: number[];
      if (this.contexts.length > 1 && uniqueDocs.length > 1) {
        // LPT bin-packing across the 2 CPU ranking contexts: sort unique docs
        // longest-first and assign each to the lighter context bucket.
        const order = uniqueDocs.map((doc, idx) => ({ idx, len: doc.length }));
        order.sort((a, b) => b.len - a.len || a.idx - b.idx);
        const buckets: Array<{
          indices: number[];
          docs: string[];
          pairs: Token[][];
          load: number;
        }> = this.contexts.map(() => ({
          indices: [],
          docs: [],
          pairs: [],
          load: 0,
        }));
        for (const item of order) {
          let lightest = buckets[0]!;
          for (let b = 1; b < buckets.length; b += 1) {
            if (buckets[b]!.load < lightest.load) {
              lightest = buckets[b]!;
            }
          }
          lightest.indices.push(item.idx);
          lightest.docs.push(uniqueDocs[item.idx]!);
          if (pairTokens) {
            lightest.pairs.push(pairTokens[item.idx]!);
          }
          lightest.load += item.len;
        }
        const bucketResults = await Promise.all(
          buckets.map((bucket, idx) =>
            bucket.docs.length > 0
              ? scoreUniqueWithContext(
                  this.contexts[idx]!,
                  query,
                  bucket.docs,
                  pairTokens ? bucket.pairs : undefined
                )
              : Promise.resolve([] as number[])
          )
        );
        uniqueScores = Array.from<number>({ length: uniqueDocs.length });
        for (let b = 0; b < buckets.length; b += 1) {
          const indices = buckets[b]!.indices;
          const scores = bucketResults[b]!;
          for (let j = 0; j < indices.length; j += 1) {
            uniqueScores[indices[j]!] = scores[j]!;
          }
        }
      } else {
        uniqueScores = await scoreUniqueWithContext(
          this.contexts[0]!,
          query,
          uniqueDocs,
          pairTokens
        );
      }
      checkEvaluation(options);

      // Expand unique scores back to all original indices and stable-sort
      // descending by score (ties preserve original input index order).
      const scored = documents.map((_, index) => ({
        index,
        score: uniqueScores[docToUniqueIndex[index]!]!,
      }));
      scored.sort((a, b) => b.score - a.score || a.index - b.index);
      const scores: RerankScore[] = scored.map((item, rank) => ({
        index: item.index,
        score: item.score,
        rank: rank + 1,
      }));

      return { ok: true, value: scores };
    } catch (e) {
      await this.releaseContext();
      return { ok: false, error: inferenceFailedError(this.modelUri, e) };
    } finally {
      lease.release();
    }
  }

  private async releaseContext(): Promise<void> {
    const contexts = this.contexts;
    this.contexts = [];
    this.contextModel = null;
    this.contextSize = undefined;
    this.contextConfiguration = undefined;
    this.contextPoolSize = 0;
    for (const context of contexts) {
      if (context && !context.disposed) {
        await context.dispose().catch(() => {
          // A failed native context must never be reused.
        });
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.pending;
    const lease = this.manager.acquireLease(this.modelUri, false);
    try {
      await this.releaseContext();
    } finally {
      lease.release();
    }
  }
}
