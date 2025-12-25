/**
 * gno search command implementation.
 * BM25 keyword search over indexed documents.
 *
 * @module src/cli/commands/search
 */

import { searchBm25 } from '../../pipeline/search';
import type { SearchOptions, SearchResults } from '../../pipeline/types';
import {
  type FormatOptions,
  formatSearchResults,
} from '../format/search-results';
import { initStore } from './shared';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SearchCommandOptions = SearchOptions & {
  /** Override config path */
  configPath?: string;
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

export type SearchResult =
  | { success: true; data: SearchResults }
  | { success: false; error: string; isValidation?: boolean };

// ─────────────────────────────────────────────────────────────────────────────
// Command Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute gno search command.
 */
export async function search(
  query: string,
  options: SearchCommandOptions = {}
): Promise<SearchResult> {
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

  const { store } = initResult;

  try {
    const result = await searchBm25(store, query, {
      ...options,
      limit,
    });

    if (!result.ok) {
      // Map INVALID_INPUT to validation error for proper exit code
      const isValidation = result.error.code === 'INVALID_INPUT';
      return {
        success: false,
        error: result.error.message,
        isValidation,
      };
    }

    return { success: true, data: result.value };
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
function getFormatType(options: SearchCommandOptions): FormatOptions['format'] {
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
 * Format search result for output.
 */
export function formatSearch(
  result: SearchResult,
  options: SearchCommandOptions
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
