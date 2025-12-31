/**
 * Server context for web UI.
 * Manages LLM ports and vector index for hybrid search and AI answers.
 *
 * @module src/serve/context
 */

import type { Config } from '../config/types';
import { LlmAdapter } from '../llm/nodeLlamaCpp/adapter';
import { getActivePreset } from '../llm/registry';
import type { EmbeddingPort, GenerationPort, RerankPort } from '../llm/types';
import type { SqliteAdapter } from '../store/sqlite/adapter';
import { createVectorIndexPort, type VectorIndexPort } from '../store/vector';

export interface ServerContext {
  store: SqliteAdapter;
  config: Config;
  vectorIndex: VectorIndexPort | null;
  embedPort: EmbeddingPort | null;
  genPort: GenerationPort | null;
  rerankPort: RerankPort | null;
  capabilities: {
    bm25: boolean;
    vector: boolean;
    hybrid: boolean;
    answer: boolean;
  };
}

/**
 * Initialize server context with LLM ports.
 * Attempts to load models; missing models are logged but don't fail.
 */
export async function createServerContext(
  store: SqliteAdapter,
  config: Config
): Promise<ServerContext> {
  let embedPort: EmbeddingPort | null = null;
  let genPort: GenerationPort | null = null;
  let rerankPort: RerankPort | null = null;
  let vectorIndex: VectorIndexPort | null = null;

  try {
    const preset = getActivePreset(config);
    const llm = new LlmAdapter(config);

    // Try to create embedding port
    const embedResult = await llm.createEmbeddingPort(preset.embed);
    if (embedResult.ok) {
      embedPort = embedResult.value;
      const initResult = await embedPort.init();
      if (initResult.ok) {
        // Create vector index
        const dimensions = embedPort.dimensions();
        const db = store.getRawDb();
        const vectorResult = await createVectorIndexPort(db, {
          model: preset.embed,
          dimensions,
        });
        if (vectorResult.ok) {
          vectorIndex = vectorResult.value;
          console.log('Vector search enabled');
        }
      }
    }

    // Try to create generation port
    const genResult = await llm.createGenerationPort(preset.gen);
    if (genResult.ok) {
      genPort = genResult.value;
      console.log('AI answer generation enabled');
    }

    // Try to create rerank port
    const rerankResult = await llm.createRerankPort(preset.rerank);
    if (rerankResult.ok) {
      rerankPort = rerankResult.value;
      console.log('Reranking enabled');
    }
  } catch (e) {
    // Log but don't fail - models are optional
    console.log(
      'LLM initialization skipped:',
      e instanceof Error ? e.message : String(e)
    );
  }

  const capabilities = {
    bm25: true, // Always available
    vector: vectorIndex?.searchAvailable ?? false,
    hybrid: (vectorIndex?.searchAvailable ?? false) && embedPort !== null,
    answer: genPort !== null,
  };

  return {
    store,
    config,
    vectorIndex,
    embedPort,
    genPort,
    rerankPort,
    capabilities,
  };
}

/**
 * Dispose server context resources.
 */
export async function disposeServerContext(ctx: ServerContext): Promise<void> {
  if (ctx.embedPort) {
    await ctx.embedPort.dispose();
  }
  if (ctx.genPort) {
    await ctx.genPort.dispose();
  }
  if (ctx.rerankPort) {
    await ctx.rerankPort.dispose();
  }
}
