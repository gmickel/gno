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
import type { VectorIndexPort } from "../store/vector";
import type { DocumentEventBus } from "./doc-events";
import type { EmbedScheduler } from "./embed-scheduler";
import type { CollectionWatchService } from "./watch-service";

import { DEFAULT_INDEX_NAME } from "../app/constants";
import { canonicalizeIndexName } from "../app/index-name";
import {
  lazyEmbeddingPort,
  lazyGenerationPort,
  lazyRerankPort,
} from "../llm/lazy-ports";
import { LlmAdapter } from "../llm/nodeLlamaCpp/adapter";
import { resolveDownloadPolicy } from "../llm/policy";
import { getActivePreset } from "../llm/registry";
import { createLazyVectorIndex } from "../store/vector/lazy";

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
  llm?: LlmAdapter;
  store: SqliteAdapter;
  config: Config;
  /** Canonical identity of the already-open resident store. */
  indexName: string;
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

export interface CreateServerContextOptions {
  offline?: boolean;
  indexName?: string;
}

/**
 * Initialize server context with LLM ports.
 * Model resolution, downloads and loading wait until actual inference.
 */
export async function createServerContext(
  store: SqliteAdapter,
  config: Config,
  options: CreateServerContextOptions = {}
): Promise<ServerContext> {
  let embedPort: EmbeddingPort | null = null;
  let expandPort: GenerationPort | null = null;
  let answerPort: GenerationPort | null = null;
  let rerankPort: RerankPort | null = null;
  let vectorIndex: VectorIndexPort | null = null;

  const llm = new LlmAdapter(config);
  try {
    const preset = getActivePreset(config);

    // Resolve download policy from env (serve has no CLI flags)
    const policy = resolveDownloadPolicy(process.env, {
      offline: options.offline ?? false,
    });

    // Progress callback updates downloadState for WebUI polling
    const createPortOptions = (type: ModelType): CreatePortOptions => ({
      egressCollections: "all",
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

    const resolvePort = async <T>(operation: () => Promise<T>): Promise<T> => {
      try {
        return await operation();
      } finally {
        downloadState.active = false;
        downloadState.currentType = null;
      }
    };
    embedPort = lazyEmbeddingPort(preset.embed, () =>
      resolvePort(() =>
        llm.createEmbeddingPort(preset.embed, createPortOptions("embed"))
      )
    );
    vectorIndex = await createLazyVectorIndex(
      store.getRawDb(),
      preset.embed,
      embedPort
    );
    const expandUri = preset.expand ?? preset.gen;
    expandPort = lazyGenerationPort(expandUri, () =>
      resolvePort(() =>
        llm.createExpansionPort(expandUri, createPortOptions("expand"))
      )
    );
    answerPort = lazyGenerationPort(preset.gen, () =>
      resolvePort(() =>
        llm.createGenerationPort(preset.gen, createPortOptions("gen"))
      )
    );
    rerankPort = lazyRerankPort(preset.rerank, () =>
      resolvePort(() =>
        llm.createRerankPort(preset.rerank, createPortOptions("rerank"))
      )
    );
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
    llm,
    store,
    config,
    indexName: canonicalizeIndexName(options.indexName ?? DEFAULT_INDEX_NAME),
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
  await ctx.llm?.dispose();
}

/**
 * Reload server context with potentially new config.
 * Disposes existing ports and recreates them.
 */
export async function reloadServerContext(
  ctx: ServerContext,
  newConfig?: Config,
  options: CreateServerContextOptions = {}
): Promise<ServerContext> {
  await disposeServerContext(ctx);
  return createServerContext(ctx.store, newConfig ?? ctx.config, {
    ...options,
    indexName: options.indexName ?? ctx.indexName,
  });
}
