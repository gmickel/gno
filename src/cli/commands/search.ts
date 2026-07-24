/**
 * gno search command implementation.
 * BM25 keyword search over indexed documents.
 *
 * @module src/cli/commands/search
 */

import type { CliProjectAffinityRequest } from "../../core/project-affinity-surface";
import type {
  RetrievalTraceSession,
  RetrievalTraceSurfaceMetadata,
} from "../../core/retrieval-trace-session";
import type { SearchOptions, SearchResults } from "../../pipeline/types";

import { normalizeContentTypes } from "../../config";
import { resolveCliProjectAffinity } from "../../core/project-affinity-surface";
import {
  finishRetrievalTraceAfterError,
  startRetrievalTraceRequest,
} from "../../core/retrieval-trace-request";
import { searchBm25 } from "../../pipeline/search";
import {
  type FormatOptions,
  formatSearchResults,
} from "../format/search-results";
import { decorateSearchResultsForIndex, initStore } from "./shared";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SearchCommandOptions = Omit<
  SearchOptions,
  "contentTypeRules" | "projectAffinity"
> &
  CliProjectAffinityRequest & {
    /** Override config path */
    configPath?: string;
    /** Index name */
    indexName?: string;
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

export type SearchResult =
  | {
      success: true;
      data: SearchResults;
      metadata?: RetrievalTraceSurfaceMetadata;
    }
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
    indexName: options.indexName,
    collection: options.collection,
    syncConfig: false,
  });

  if (!initResult.ok) {
    return { success: false, error: initResult.error };
  }

  const { store, config } = initResult;
  let traceSession: RetrievalTraceSession | undefined;

  try {
    const { projectAffinityDisabled, projectRoots, ...searchOptions } = options;
    const projectAffinity = await resolveCliProjectAffinity(config, {
      cwd: process.cwd(),
      disabled: projectAffinityDisabled,
      projectRoots,
    });
    const started = await startRetrievalTraceRequest({
      store,
      config,
      query,
      filters: {
        limit,
        collection: options.collection,
        lang: options.lang,
        full: options.full,
        lineNumbers: options.lineNumbers,
        tagsAll: options.tagsAll,
        tagsAny: options.tagsAny,
        since: options.since,
        until: options.until,
        categories: options.categories,
        author: options.author,
        intent: options.intent,
        exclude: options.exclude,
      },
      pipeline: "bm25",
      indexName: options.indexName,
    });
    if (!started.ok) return { success: false, error: started.error.message };
    traceSession = started.value ?? undefined;
    const result = await searchBm25(store, query, {
      ...searchOptions,
      limit,
      projectAffinity,
      contentTypeRules: normalizeContentTypes(config.contentTypes ?? []).rules,
      traceSession,
    });

    if (!result.ok) {
      await traceSession?.finish("failed");
      // Map INVALID_INPUT to validation error for proper exit code
      const isValidation = result.error.code === "INVALID_INPUT";
      return {
        success: false,
        error: result.error.message,
        isValidation,
      };
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
      error: cause instanceof Error ? cause.message : "Search failed",
    };
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
function getFormatType(options: SearchCommandOptions): FormatOptions["format"] {
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
 * Format search result for output.
 */
export function formatSearch(
  result: SearchResult,
  options: SearchCommandOptions
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
