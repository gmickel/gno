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
  private contextPromise: Promise<LlmResult<LlamaEmbeddingContext>> | null =
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
    const ctx = await this.getContext();
    if (!ctx.ok) {
      return ctx;
    }
    return { ok: true, value: undefined };
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
      throw new Error('Call init() or embed() first to initialize dimensions');
    }
    return this.dims;
  }

  async dispose(): Promise<void> {
    // Clear promise first to prevent reuse of disposed context
    this.contextPromise = null;
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

  private getContext(): Promise<LlmResult<LlamaEmbeddingContext>> {
    // Return cached context
    if (this.context) {
      return Promise.resolve({ ok: true, value: this.context });
    }

    // Reuse in-flight promise to prevent concurrent context creation
    if (this.contextPromise) {
      return this.contextPromise;
    }

    this.contextPromise = this.createContext();
    return this.contextPromise;
  }

  private async createContext(): Promise<LlmResult<LlamaEmbeddingContext>> {
    const model = await this.manager.loadModel(
      this.modelPath,
      this.modelUri,
      'embed'
    );
    if (!model.ok) {
      this.contextPromise = null; // Allow retry
      return model;
    }

    try {
      // Cast to access createEmbeddingContext
      const llamaModel = model.value.model as LlamaModel;
      this.context = await llamaModel.createEmbeddingContext();

      // Cache dimensions from model (available without running embed)
      const size = llamaModel.embeddingVectorSize;
      if (this.dims === null && typeof size === 'number' && size > 0) {
        this.dims = size;
      }

      return { ok: true, value: this.context };
    } catch (e) {
      this.contextPromise = null; // Allow retry
      return { ok: false, error: inferenceFailedError(this.modelUri, e) };
    }
  }
}
