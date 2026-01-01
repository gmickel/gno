/**
 * gno vsearch command implementation.
 * Vector semantic search over indexed documents.
 *
 * @module src/cli/commands/vsearch
 */

import { LlmAdapter } from '../../llm/nodeLlamaCpp/adapter';
import { getActivePreset } from '../../llm/registry';
import { formatQueryForEmbedding } from '../../pipeline/contextual';
import type { SearchOptions, SearchResults } from '../../pipeline/types';
import {
  searchVectorWithEmbedding,
  type VectorSearchDeps,
} from '../../pipeline/vsearch';
import { createVectorIndexPort } from '../../store/vector';
import {
  type FormatOptions,
  formatSearchResults,
} from '../format/search-results';
import { initStore } from './shared';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type VsearchCommandOptions = SearchOptions & {
  /** Override config path */
  configPath?: string;
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
};

export type VsearchResult =
  | { success: true; data: SearchResults }
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
    collection: options.collection,
  });

  if (!initResult.ok) {
    return { success: false, error: initResult.error };
  }

  const { store, config } = initResult;

  try {
    // Get model URI from preset
    const preset = getActivePreset(config);
    const modelUri = options.model ?? preset.embed;

    // Create LLM adapter for embeddings
    const llm = new LlmAdapter(config);
    const embedResult = await llm.createEmbeddingPort(modelUri);
    if (!embedResult.ok) {
      return { success: false, error: embedResult.error.message };
    }

    const embedPort = embedResult.value;

    try {
      // Embed query with contextual formatting (also determines dimensions)
      const queryEmbedResult = await embedPort.embed(
        formatQueryForEmbedding(query)
      );
      if (!queryEmbedResult.ok) {
        return { success: false, error: queryEmbedResult.error.message };
      }
      const queryEmbedding = new Float32Array(queryEmbedResult.value);
      const dimensions = queryEmbedding.length;

      // Create vector index port
      const db = store.getRawDb();
      const vectorResult = await createVectorIndexPort(db, {
        model: modelUri,
        dimensions,
      });

      if (!vectorResult.ok) {
        return { success: false, error: vectorResult.error.message };
      }

      const vectorIndex = vectorResult.value;

      const deps: VectorSearchDeps = {
        store,
        vectorIndex,
        embedPort,
        config,
      };

      // Pass pre-computed embedding to avoid double-embed
      const result = await searchVectorWithEmbedding(
        deps,
        query,
        queryEmbedding,
        { ...options, limit }
      );

      if (!result.ok) {
        return { success: false, error: result.error.message };
      }

      return { success: true, data: result.value };
    } finally {
      await embedPort.dispose();
    }
  } finally {
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
): FormatOptions['format'] {
  if (options.json) {
    return 'json';
  }
  if (options.files) {
    return 'files';
  }
  if (options.csv) {
    return 'csv';
  }
  if (options.md) {
    return 'md';
  }
  if (options.xml) {
    return 'xml';
  }
  return 'terminal';
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
          error: { code: 'QUERY_FAILED', message: result.error },
        })
      : `Error: ${result.error}`;
  }

  const formatOpts: FormatOptions = {
    format: getFormatType(options),
    full: options.full,
    lineNumbers: options.lineNumbers,
  };

  return formatSearchResults(result.data, formatOpts);
}
