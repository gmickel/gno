/**
 * gno vsearch command implementation.
 * Vector semantic search over indexed documents.
 *
 * @module src/cli/commands/vsearch
 */

import type {
  RetrievalTraceSession,
  RetrievalTraceSurfaceMetadata,
} from "../../core/retrieval-trace-session";
import type { EmbeddingPort } from "../../llm/types";
import type { SearchOptions, SearchResults } from "../../pipeline/types";

import {
  finishRetrievalTraceAfterError,
  retrievalTraceFilters,
  startRetrievalTraceRequest,
} from "../../core/retrieval-trace-request";
import { LlmAdapter } from "../../llm/nodeLlamaCpp/adapter";
import { resolveModelUri } from "../../llm/registry";
import { formatQueryForEmbedding } from "../../pipeline/contextual";
import {
  searchVectorWithEmbedding,
  type VectorSearchDeps,
} from "../../pipeline/vsearch";
import { createVectorIndexPort } from "../../store/vector";
import {
  type FormatOptions,
  formatSearchResults,
} from "../format/search-results";
import { decorateSearchResultsForIndex, initStore } from "./shared";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type VsearchCommandOptions = SearchOptions & {
  /** Override config path */
  configPath?: string;
  /** Index name */
  indexName?: string;
  /** Override model URI */
  model?: string;
  /** Output as JSON */
  json?: boolean;
  /** Output as Markdown */
  md?: boolean;
  /** Output as CSV */
  csv?: boolean;
  /** Output as XML */
  xml?: boolean;
  /** Output files only */
  files?: boolean;
  /** Terminal hyperlink policy */
  terminalLinks?: FormatOptions["terminalLinks"];
};

export type VsearchResult =
  | {
      success: true;
      data: SearchResults;
      metadata?: RetrievalTraceSurfaceMetadata;
    }
  | { success: false; error: string };

// ─────────────────────────────────────────────────────────────────────────────
// Command Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute gno vsearch command.
 */
export async function vsearch(
  query: string,
  options: VsearchCommandOptions = {}
): Promise<VsearchResult> {
  // Adjust default limit based on output format
  const isStructured =
    options.json || options.files || options.csv || options.xml;
  const limit = options.limit ?? (isStructured ? 20 : 5);

  const initResult = await initStore({
    configPath: options.configPath,
    indexName: options.indexName,
    collection: options.collection,
    syncConfig: false,
  });

  if (!initResult.ok) {
    return { success: false, error: initResult.error };
  }

  const { store, config } = initResult;
  let embedPort: EmbeddingPort | null = null;
  let traceSession: RetrievalTraceSession | undefined;

  try {
    // Get model URI from preset
    const modelUri = resolveModelUri(
      config,
      "embed",
      options.model,
      options.collection
    );
    const traceStart = await startRetrievalTraceRequest({
      store,
      config,
      query,
      filters: retrievalTraceFilters({ ...options, limit }),
      pipeline: "vector",
      indexName: options.indexName,
      modelUris: [modelUri],
    });
    if (!traceStart.ok) {
      return { success: false, error: traceStart.error.message };
    }
    traceSession = traceStart.value ?? undefined;

    // Create LLM adapter for embeddings
    const llm = new LlmAdapter(config);
    const embedResult = await llm.createEmbeddingPort(modelUri);
    if (!embedResult.ok) {
      await traceSession?.finish("failed");
      return { success: false, error: embedResult.error.message };
    }

    embedPort = embedResult.value;
    const queryEmbedResult = await embedPort.embed(
      formatQueryForEmbedding(query, embedPort.modelUri)
    );
    if (!queryEmbedResult.ok) {
      await traceSession?.finish("failed");
      return { success: false, error: queryEmbedResult.error.message };
    }
    const queryEmbedding = new Float32Array(queryEmbedResult.value);
    const vectorResult = await createVectorIndexPort(store.getRawDb(), {
      model: modelUri,
      dimensions: queryEmbedding.length,
    });
    if (!vectorResult.ok) {
      await traceSession?.finish("failed");
      return { success: false, error: vectorResult.error.message };
    }
    const deps: VectorSearchDeps = {
      store,
      vectorIndex: vectorResult.value,
      embedPort,
      config,
    };
    const result = await searchVectorWithEmbedding(
      deps,
      query,
      queryEmbedding,
      { ...options, limit, traceSession }
    );
    if (!result.ok) {
      await traceSession?.finish("failed");
      return { success: false, error: result.error.message };
    }
    return {
      success: true,
      data: decorateSearchResultsForIndex(result.value, options.indexName),
      metadata: traceSession?.metadata(),
    };
  } catch (cause) {
    await finishRetrievalTraceAfterError(traceSession, cause);
    return {
      success: false,
      error: cause instanceof Error ? cause.message : "Vector search failed",
    };
  } finally {
    await embedPort?.dispose();
    await store.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get output format from options.
 */
function getFormatType(
  options: VsearchCommandOptions
): FormatOptions["format"] {
  if (options.json) {
    return "json";
  }
  if (options.files) {
    return "files";
  }
  if (options.csv) {
    return "csv";
  }
  if (options.md) {
    return "md";
  }
  if (options.xml) {
    return "xml";
  }
  return "terminal";
}

/**
 * Format vsearch result for output.
 */
export function formatVsearch(
  result: VsearchResult,
  options: VsearchCommandOptions
): string {
  if (!result.success) {
    return options.json
      ? JSON.stringify({
          error: { code: "QUERY_FAILED", message: result.error },
        })
      : `Error: ${result.error}`;
  }
  const formatOpts: FormatOptions = {
    format: getFormatType(options),
    full: options.full,
    lineNumbers: options.lineNumbers,
    terminalLinks: options.terminalLinks,
  };

  return formatSearchResults(result.data, formatOpts);
}
