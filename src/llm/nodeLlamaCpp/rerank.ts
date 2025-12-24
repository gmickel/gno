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

    try {
      const llamaModel = model.value.model as LlamaModel;
      const context = await llamaModel.createRankingContext();

      const ranked = await context.rankAndSort(query, documents);

      // Convert to RerankScore format
      const scores: RerankScore[] = ranked.map((item, rank) => ({
        index: documents.indexOf(item.document),
        score: item.score,
        rank: rank + 1,
      }));

      // Cleanup
      await context.dispose();

      return { ok: true, value: scores };
    } catch (e) {
      return { ok: false, error: inferenceFailedError(this.modelUri, e) };
    }
  }

  async dispose(): Promise<void> {
    // Rerank doesn't hold persistent context
    // Model cleanup is handled by ModelManager
  }
}
