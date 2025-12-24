/**
 * Rerank port implementation using node-llama-cpp.
 *
 * @module src/llm/nodeLlamaCpp/rerank
 */

import { inferenceFailedError } from '../errors';
import type { LlmResult, RerankPort, RerankScore } from '../types';
import type { ModelManager } from './lifecycle';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type LlamaModel = Awaited<
  ReturnType<
    Awaited<ReturnType<typeof import('node-llama-cpp').getLlama>>['loadModel']
  >
>;

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

export class NodeLlamaCppRerank implements RerankPort {
  private readonly manager: ModelManager;
  readonly modelUri: string;
  private readonly modelPath: string;

  constructor(manager: ModelManager, modelUri: string, modelPath: string) {
    this.manager = manager;
    this.modelUri = modelUri;
    this.modelPath = modelPath;
  }

  async rerank(
    query: string,
    documents: string[]
  ): Promise<LlmResult<RerankScore[]>> {
    if (documents.length === 0) {
      return { ok: true, value: [] };
    }

    const model = await this.manager.loadModel(
      this.modelPath,
      this.modelUri,
      'rerank'
    );
    if (!model.ok) {
      return model;
    }

    // Build index map for O(1) lookups (handles duplicates correctly)
    const indexMap = new Map<string, number[]>();
    for (let i = 0; i < documents.length; i += 1) {
      const doc = documents[i] as string; // Guaranteed by loop bounds
      const indices = indexMap.get(doc) ?? [];
      indices.push(i);
      indexMap.set(doc, indices);
    }

    const llamaModel = model.value.model as LlamaModel;
    const context = await llamaModel.createRankingContext();

    try {
      const ranked = await context.rankAndSort(query, documents);

      // Convert to RerankScore format with O(1) index lookup
      const scores: RerankScore[] = ranked.map((item, rank) => {
        const indices = indexMap.get(item.document) ?? [];
        // Shift to handle duplicates (each duplicate gets next index)
        const index = indices.shift() ?? -1;
        return {
          index,
          score: item.score,
          rank: rank + 1,
        };
      });

      return { ok: true, value: scores };
    } catch (e) {
      return { ok: false, error: inferenceFailedError(this.modelUri, e) };
    } finally {
      await context.dispose().catch(() => {
        // Ignore disposal errors
      });
    }
  }

  async dispose(): Promise<void> {
    // Rerank doesn't hold persistent context
    // Model cleanup is handled by ModelManager
  }
}
