/**
 * MCP gno_search tool - BM25 full-text search.
 *
 * @module src/mcp/tools/search
 */

import { join as pathJoin } from "node:path";

import type { RetrievalTraceSession } from "../../core/retrieval-trace-session";
import type { SearchResult, SearchResults } from "../../pipeline/types";
import type { ToolContext } from "../server";

import { decorateResultUris, parseUri } from "../../app/constants";
import { normalizeContentTypes } from "../../config";
import { resolveRemoteProjectAffinity } from "../../core/project-affinity-surface";
import {
  finishRetrievalTraceAfterError,
  retrievalTraceFilters,
  startRetrievalTraceRequest,
} from "../../core/retrieval-trace-request";
import { attachRetrievalTraceMetadata } from "../../core/retrieval-trace-session";
import {
  normalizeMetadataPredicate,
  type MetadataPredicate,
} from "../../core/typed-metadata";
import { searchBm25 } from "../../pipeline/search";
import { appendRetrievalWarnings } from "../retrieval-warnings";
import {
  finishScopedRetrieval,
  mcpAccessScope,
  provenanceRetrievalScope,
  scopeRetrievalArgs,
} from "./access";
import {
  assertCollectionsExist,
  normalizeTagFilters,
  runTool,
  type ToolResult,
} from "./index";

interface SearchInput {
  query: string;
  projectHints?: string[];
  collection?: string;
  collections?: string[];
  limit?: number;
  minScore?: number;
  lang?: string;
  intent?: string;
  exclude?: string[];
  since?: string;
  until?: string;
  categories?: string[];
  author?: string;
  filter?: MetadataPredicate;
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
      ...decorateResultUris(r, ctx.indexName),
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
    if (r.supersededBy) {
      lines.push(`  Superseded by: ${r.supersededBy}`);
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
  requestArgs: SearchInput,
  ctx: ToolContext
): Promise<ToolResult> {
  return runTool(
    ctx,
    "gno_search",
    async () => {
      const scope = mcpAccessScope(ctx);
      const callerCollections = requestArgs.collections;
      const args = scope ? scopeRetrievalArgs(scope, requestArgs) : requestArgs;
      // Validate collections exist if specified
      assertCollectionsExist(ctx, [
        args.collection,
        ...(args.collections ?? []),
      ]);

      const projectAffinity = await resolveRemoteProjectAffinity(
        ctx.config,
        args.projectHints
      );
      const options = {
        limit: args.limit ?? 5,
        minScore: args.minScore,
        collection: args.collection,
        collections: args.collections,
        lang: args.lang,
        intent: args.intent,
        exclude: args.exclude,
        since: args.since,
        until: args.until,
        categories: args.categories,
        author: args.author,
        filter:
          args.filter === undefined
            ? undefined
            : normalizeMetadataPredicate(args.filter),
        tagsAll: normalizeTagFilters(args.tagsAll),
        tagsAny: normalizeTagFilters(args.tagsAny),
        projectAffinity,
        contentTypeRules: normalizeContentTypes(ctx.config.contentTypes ?? [])
          .rules,
        ...(scope ? await provenanceRetrievalScope(scope, ctx.store) : {}),
      };
      let traceSession: RetrievalTraceSession | undefined;
      try {
        const traceStart = await startRetrievalTraceRequest({
          store: ctx.store,
          config: ctx.config,
          query: args.query,
          filters: retrievalTraceFilters(options),
          pipeline: "bm25",
          indexName: ctx.indexName,
        });
        if (!traceStart.ok) throw new Error(traceStart.error.message);
        traceSession = traceStart.value ?? undefined;
        const result = await searchBm25(ctx.store, args.query, {
          ...options,
          traceSession,
        });
        if (!result.ok) throw new Error(result.error.message);
        const value = scope
          ? await finishScopedRetrieval(
              scope,
              ctx.store,
              callerCollections,
              result.value
            )
          : result.value;
        return attachRetrievalTraceMetadata(
          {
            ...value,
            results: enrichWithAbsPath(value.results, ctx),
          },
          traceSession
        );
      } catch (cause) {
        await finishRetrievalTraceAfterError(traceSession, cause);
        throw cause;
      }
    },
    (data) =>
      appendRetrievalWarnings(formatSearchResults(data), data.meta.warnings)
  );
}
