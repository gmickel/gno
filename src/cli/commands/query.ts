/**
 * gno query command implementation.
 * Hybrid search with expansion, fusion, and reranking.
 *
 * @module src/cli/commands/query
 */

import { LlmAdapter } from '../../llm/nodeLlamaCpp/adapter';
import { getActivePreset } from '../../llm/registry';
import type {
  EmbeddingPort,
  GenerationPort,
  RerankPort,
} from '../../llm/types';
import { type HybridSearchDeps, searchHybrid } from '../../pipeline/hybrid';
import type { HybridSearchOptions, SearchResults } from '../../pipeline/types';
import {
  createVectorIndexPort,
  type VectorIndexPort,
} from '../../store/vector';
import { initStore } from './shared';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type QueryCommandOptions = HybridSearchOptions & {
  /** Override config path */
  configPath?: string;
  /** Override embedding model */
  embedModel?: string;
  /** Override generation model */
  genModel?: string;
  /** Override rerank model */
  rerankModel?: string;
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

export interface QueryFormatOptions {
  format: 'terminal' | 'json' | 'files' | 'csv' | 'md' | 'xml';
  full?: boolean;
  lineNumbers?: boolean;
}

export type QueryResult =
  | { success: true; data: SearchResults }
  | { success: false; error: string };

// ─────────────────────────────────────────────────────────────────────────────
// Command Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute gno query command.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: CLI orchestration with multiple output formats
export async function query(
  queryText: string,
  options: QueryCommandOptions = {}
): Promise<QueryResult> {
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

  let embedPort: EmbeddingPort | null = null;
  let genPort: GenerationPort | null = null;
  let rerankPort: RerankPort | null = null;

  try {
    const preset = getActivePreset(config);
    const llm = new LlmAdapter(config);

    // Create embedding port (for vector search)
    const embedUri = options.embedModel ?? preset.embed;
    const embedResult = await llm.createEmbeddingPort(embedUri);
    if (embedResult.ok) {
      embedPort = embedResult.value;
    }

    // Create generation port (for expansion) - optional
    if (!options.noExpand) {
      const genUri = options.genModel ?? preset.gen;
      const genResult = await llm.createGenerationPort(genUri);
      if (genResult.ok) {
        genPort = genResult.value;
      }
    }

    // Create rerank port - optional
    if (!options.noRerank) {
      const rerankUri = options.rerankModel ?? preset.rerank;
      const rerankResult = await llm.createRerankPort(rerankUri);
      if (rerankResult.ok) {
        rerankPort = rerankResult.value;
      }
    }

    // Create vector index (optional)
    let vectorIndex: VectorIndexPort | null = null;
    if (embedPort) {
      const embedInitResult = await embedPort.init();
      if (embedInitResult.ok) {
        const dimensions = embedPort.dimensions();
        const db = store.getRawDb();
        const vectorResult = await createVectorIndexPort(db, {
          model: embedUri,
          dimensions,
        });
        if (vectorResult.ok) {
          vectorIndex = vectorResult.value;
        }
      }
    }

    const deps: HybridSearchDeps = {
      store,
      config,
      vectorIndex,
      embedPort,
      genPort,
      rerankPort,
    };

    const result = await searchHybrid(deps, queryText, {
      ...options,
      limit,
    });

    if (!result.ok) {
      return { success: false, error: result.error.message };
    }

    return { success: true, data: result.value };
  } finally {
    if (embedPort) {
      await embedPort.dispose();
    }
    if (genPort) {
      await genPort.dispose();
    }
    if (rerankPort) {
      await rerankPort.dispose();
    }
    await store.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────────────────────────

// Import shared formatters dynamically to keep module loading fast
// and avoid circular dependencies

/**
 * Output explain data to stderr using pipeline formatters.
 */
function outputExplainToStderr(data: SearchResults): void {
  const explain = data.meta.explain;
  if (!explain) {
    return;
  }

  // Import pipeline formatters synchronously (they're lightweight)
  const {
    formatExplain,
    formatResultExplain,
  } = require('../../pipeline/explain');
  process.stderr.write(`${formatExplain(explain.lines)}\n`);
  process.stderr.write(`${formatResultExplain(explain.results)}\n`);
}

/**
 * Format query result for output.
 * Uses shared formatSearchResults for consistent output across search commands.
 */
export function formatQuery(
  result: QueryResult,
  options: QueryFormatOptions
): string {
  if (!result.success) {
    return options.format === 'json'
      ? JSON.stringify({
          error: { code: 'QUERY_FAILED', message: result.error },
        })
      : `Error: ${result.error}`;
  }

  // Output explain to stderr if present (async but best-effort)
  outputExplainToStderr(result.data);

  // Use shared formatter for consistent output
  // Dynamic import to keep module loading fast
  const { formatSearchResults } = require('../format/search-results');
  return formatSearchResults(result.data, {
    format: options.format,
    full: options.full,
    lineNumbers: options.lineNumbers,
  });
}
