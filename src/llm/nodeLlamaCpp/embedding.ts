/**
 * Embedding port implementation using node-llama-cpp.
 *
 * @module src/llm/nodeLlamaCpp/embedding
 */

import { inferenceFailedError } from '../errors';
import type { EmbeddingPort, LlmResult } from '../types';
import type { ModelManager } from './lifecycle';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

// LlamaModel type from node-llama-cpp
type LlamaModel = Awaited<
  ReturnType<
    Awaited<ReturnType<typeof import('node-llama-cpp').getLlama>>['loadModel']
  >
>;

type LlamaEmbeddingContext = Awaited<
  ReturnType<LlamaModel['createEmbeddingContext']>
>;

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

export class NodeLlamaCppEmbedding implements EmbeddingPort {
  private context: LlamaEmbeddingContext | null = null;
  private dims: number | null = null;
  private readonly manager: ModelManager;
  readonly modelUri: string;
  private readonly modelPath: string;

  constructor(manager: ModelManager, modelUri: string, modelPath: string) {
    this.manager = manager;
    this.modelUri = modelUri;
    this.modelPath = modelPath;
  }

  async embed(text: string): Promise<LlmResult<number[]>> {
    const ctx = await this.getContext();
    if (!ctx.ok) {
      return ctx;
    }

    try {
      const embedding = await ctx.value.getEmbeddingFor(text);
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
    const ctx = await this.getContext();
    if (!ctx.ok) {
      return ctx;
    }

    try {
      const results: number[][] = [];
      for (const text of texts) {
        const embedding = await ctx.value.getEmbeddingFor(text);
        const vector = Array.from(embedding.vector) as number[];
        results.push(vector);

        // Cache dimensions on first call
        if (this.dims === null) {
          this.dims = vector.length;
        }
      }
      return { ok: true, value: results };
    } catch (e) {
      return { ok: false, error: inferenceFailedError(this.modelUri, e) };
    }
  }

  dimensions(): number {
    if (this.dims === null) {
      throw new Error('Call embed() first to initialize dimensions');
    }
    return this.dims;
  }

  async dispose(): Promise<void> {
    if (this.context) {
      try {
        await this.context.dispose();
      } catch {
        // Ignore disposal errors
      }
      this.context = null;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Private
  // ───────────────────────────────────────────────────────────────────────────

  private async getContext(): Promise<LlmResult<LlamaEmbeddingContext>> {
    if (this.context) {
      return { ok: true, value: this.context };
    }

    const model = await this.manager.loadModel(
      this.modelPath,
      this.modelUri,
      'embed'
    );
    if (!model.ok) {
      return model;
    }

    try {
      // Cast to access createEmbeddingContext
      const llamaModel = model.value.model as LlamaModel;
      this.context = await llamaModel.createEmbeddingContext();
      return { ok: true, value: this.context };
    } catch (e) {
      return { ok: false, error: inferenceFailedError(this.modelUri, e) };
    }
  }
}
