/**
 * Server context for web UI.
 * Manages LLM ports and vector index for hybrid search and AI answers.
 *
 * @module src/serve/context
 */

import type { Config } from "../config/types";
import type { CreatePortOptions } from "../llm/nodeLlamaCpp/adapter";
import type {
  DownloadProgress,
  EmbeddingPort,
  GenerationPort,
  ModelType,
  RerankPort,
} from "../llm/types";
import type { SqliteAdapter } from "../store/sqlite/adapter";
import type { DocumentEventBus } from "./doc-events";
import type { EmbedScheduler } from "./embed-scheduler";
import type { CollectionWatchService } from "./watch-service";

import { LlmAdapter } from "../llm/nodeLlamaCpp/adapter";
import { resolveDownloadPolicy } from "../llm/policy";
import { getActivePreset } from "../llm/registry";
import { createVectorIndexPort, type VectorIndexPort } from "../store/vector";

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
  expandPort: GenerationPort | null;
  answerPort: GenerationPort | null;
  rerankPort: RerankPort | null;
  capabilities: {
    bm25: boolean;
    vector: boolean;
    hybrid: boolean;
    answer: boolean;
  };
  scheduler?: EmbedScheduler | null;
  eventBus?: DocumentEventBus | null;
  watchService?: CollectionWatchService | null;
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
  let expandPort: GenerationPort | null = null;
  let answerPort: GenerationPort | null = null;
  let rerankPort: RerankPort | null = null;
  let vectorIndex: VectorIndexPort | null = null;

  try {
    const preset = getActivePreset(config);
    const llm = new LlmAdapter(config);

    // Resolve download policy from env (serve has no CLI flags)
    const policy = resolveDownloadPolicy(process.env, {});

    // Progress callback updates downloadState for WebUI polling
    const createPortOptions = (type: ModelType): CreatePortOptions => ({
      policy,
      onProgress: (progress) => {
        downloadState.active = true;
        downloadState.currentType = type;
        downloadState.progress = progress;
        if (progress.percent >= 100) {
          downloadState.completed.push(type);
        }
      },
    });

    // Try to create embedding port
    const embedResult = await llm.createEmbeddingPort(
      preset.embed,
      createPortOptions("embed")
    );
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
          console.log("Vector search enabled");
        }
      }
    }

    // Try to create expansion port
    const expandResult = await llm.createExpansionPort(
      preset.expand ?? preset.gen,
      createPortOptions("expand")
    );
    if (expandResult.ok) {
      expandPort = expandResult.value;
      console.log("Query expansion enabled");
    }

    // Try to create answer generation port
    const answerResult = await llm.createGenerationPort(
      preset.gen,
      createPortOptions("gen")
    );
    if (answerResult.ok) {
      answerPort = answerResult.value;
      console.log("AI answer generation enabled");
    }

    // Try to create rerank port
    const rerankResult = await llm.createRerankPort(
      preset.rerank,
      createPortOptions("rerank")
    );
    if (rerankResult.ok) {
      rerankPort = rerankResult.value;
      console.log("Reranking enabled");
    }

    // Reset download state after initialization
    if (downloadState.active) {
      downloadState.active = false;
      downloadState.currentType = null;
    }
  } catch (e) {
    // Log but don't fail - models are optional
    console.log(
      "LLM initialization skipped:",
      e instanceof Error ? e.message : String(e)
    );
  }

  const capabilities = {
    bm25: true, // Always available
    vector: vectorIndex?.searchAvailable ?? false,
    hybrid: (vectorIndex?.searchAvailable ?? false) && embedPort !== null,
    answer: answerPort !== null,
  };

  return {
    store,
    config,
    vectorIndex,
    embedPort,
    expandPort,
    answerPort,
    rerankPort,
    capabilities,
    scheduler: null,
    eventBus: null,
    watchService: null,
  };
}

/**
 * Dispose server context resources.
 * Each port is disposed independently to prevent one failure from blocking others.
 */
export async function disposeServerContext(ctx: ServerContext): Promise<void> {
  const ports = [
    { name: "embed", port: ctx.embedPort },
    { name: "expand", port: ctx.expandPort },
    { name: "answer", port: ctx.answerPort },
    { name: "rerank", port: ctx.rerankPort },
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
