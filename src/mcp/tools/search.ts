/**
 * MCP gno_search tool - BM25 full-text search.
 *
 * @module src/mcp/tools/search
 */

import { join as pathJoin } from "node:path";

import type { SearchResult, SearchResults } from "../../pipeline/types";
import type { ToolContext } from "../server";

import { parseUri } from "../../app/constants";
import { searchBm25 } from "../../pipeline/search";
import { normalizeTagFilters, runTool, type ToolResult } from "./index";

interface SearchInput {
  query: string;
  collection?: string;
  limit?: number;
  minScore?: number;
  lang?: string;
  tagsAll?: string[];
  tagsAny?: string[];
}

/**
 * Enrich results with absPath derived from each result's URI.
 */
function enrichWithAbsPath(
  results: SearchResult[],
  ctx: ToolContext
): SearchResult[] {
  return results.map((r) => {
    const parsed = parseUri(r.uri);
    if (!parsed) {
      return r;
    }

    const collection = ctx.collections.find(
      (c) => c.name === parsed.collection
    );
    if (!collection) {
      return r;
    }

    return {
      ...r,
      source: {
        ...r.source,
        absPath: pathJoin(collection.path, r.source.relPath),
      },
    };
  });
}

/**
 * Format search results as text for MCP content.
 */
function formatSearchResults(data: SearchResults): string {
  if (data.results.length === 0) {
    return `No results found for "${data.meta.query}"`;
  }

  const lines: string[] = [];
  lines.push(`Found ${data.results.length} results for "${data.meta.query}":`);
  lines.push("");

  for (const r of data.results) {
    lines.push(`[${r.docid}] ${r.uri} (score: ${r.score.toFixed(3)})`);
    if (r.title) {
      lines.push(`  Title: ${r.title}`);
    }
    if (r.snippet) {
      const snippetPreview = r.snippet.slice(0, 200).replace(/\n/g, " ");
      lines.push(`  ${snippetPreview}${r.snippet.length > 200 ? "..." : ""}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Handle gno_search tool call.
 */
export function handleSearch(
  args: SearchInput,
  ctx: ToolContext
): Promise<ToolResult> {
  return runTool(
    ctx,
    "gno_search",
    async () => {
      // Validate collection exists if specified
      if (args.collection) {
        const exists = ctx.collections.some((c) => c.name === args.collection);
        if (!exists) {
          throw new Error(`Collection not found: ${args.collection}`);
        }
      }

      const result = await searchBm25(ctx.store, args.query, {
        limit: args.limit ?? 5,
        minScore: args.minScore,
        collection: args.collection,
        lang: args.lang,
        tagsAll: normalizeTagFilters(args.tagsAll),
        tagsAny: normalizeTagFilters(args.tagsAny),
      });

      if (!result.ok) {
        throw new Error(result.error.message);
      }

      // Enrich with absPath
      const enrichedResults = enrichWithAbsPath(result.value.results, ctx);

      return {
        ...result.value,
        results: enrichedResults,
      };
    },
    formatSearchResults
  );
}
