/**
 * Server context for web UI.
 * Manages LLM ports and vector index for hybrid search and AI answers.
 *
 * @module src/serve/context
 */

import type { Config } from '../config/types';
import { LlmAdapter } from '../llm/nodeLlamaCpp/adapter';
import { getActivePreset } from '../llm/registry';
import type {
  DownloadProgress,
  EmbeddingPort,
  GenerationPort,
  ModelType,
  RerankPort,
} from '../llm/types';
import type { SqliteAdapter } from '../store/sqlite/adapter';
import { createVectorIndexPort, type VectorIndexPort } from '../store/vector';

// ─────────────────────────────────────────────────────────────────────────────
// Download State (in-memory, single user)
// ─────────────────────────────────────────────────────────────────────────────

export interface DownloadState {
  active: boolean;
  currentType: ModelType | null;
  progress: DownloadProgress | null;
  completed: ModelType[];
  failed: Array<{ type: ModelType; error: string }>;
  startedAt: number | null;
}

/** Global download state for polling */
export const downloadState: DownloadState = {
  active: false,
  currentType: null,
  progress: null,
  completed: [],
  failed: [],
  startedAt: null,
};

/** Reset download state */
export function resetDownloadState(): void {
  downloadState.active = false;
  downloadState.currentType = null;
  downloadState.progress = null;
  downloadState.completed = [];
  downloadState.failed = [];
  downloadState.startedAt = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Server Context
// ─────────────────────────────────────────────────────────────────────────────

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
 * Each port is disposed independently to prevent one failure from blocking others.
 */
export async function disposeServerContext(ctx: ServerContext): Promise<void> {
  const ports = [
    { name: 'embed', port: ctx.embedPort },
    { name: 'gen', port: ctx.genPort },
    { name: 'rerank', port: ctx.rerankPort },
  ];

  for (const { name, port } of ports) {
    if (port) {
      try {
        await port.dispose();
      } catch (e) {
        console.error(`Failed to dispose ${name} port:`, e);
      }
    }
  }
}

/**
 * Reload server context with potentially new config.
 * Disposes existing ports and recreates them.
 */
export async function reloadServerContext(
  ctx: ServerContext,
  newConfig?: Config
): Promise<ServerContext> {
  await disposeServerContext(ctx);
  return createServerContext(ctx.store, newConfig ?? ctx.config);
}
