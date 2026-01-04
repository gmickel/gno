/**
 * MCP gno_vsearch tool - Vector/semantic similarity search.
 *
 * @module src/mcp/tools/vsearch
 */

import { join as pathJoin } from "node:path";

import type { SearchResult, SearchResults } from "../../pipeline/types";
import type { ToolContext } from "../server";

import { parseUri } from "../../app/constants";
import { createNonTtyProgressRenderer } from "../../cli/progress";
import { LlmAdapter } from "../../llm/nodeLlamaCpp/adapter";
import { resolveDownloadPolicy } from "../../llm/policy";
import { getActivePreset } from "../../llm/registry";
import { formatQueryForEmbedding } from "../../pipeline/contextual";
import {
  searchVectorWithEmbedding,
  type VectorSearchDeps,
} from "../../pipeline/vsearch";
import { createVectorIndexPort } from "../../store/vector";
import { normalizeTagFilters, runTool, type ToolResult } from "./index";

interface VsearchInput {
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
  lines.push(
    `Found ${data.results.length} results for "${data.meta.query}" (vector search):`
  );
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
 * Handle gno_vsearch tool call.
 */
export function handleVsearch(
  args: VsearchInput,
  ctx: ToolContext
): Promise<ToolResult> {
  return runTool(
    ctx,
    "gno_vsearch",
    // oxlint-disable-next-line max-lines-per-function -- vector search with validation and result formatting
    async () => {
      // Validate collection exists if specified
      if (args.collection) {
        const exists = ctx.collections.some((c) => c.name === args.collection);
        if (!exists) {
          throw new Error(`Collection not found: ${args.collection}`);
        }
      }

      // Get model from active preset
      const preset = getActivePreset(ctx.config);
      const modelUri = preset.embed;

      // Resolve download policy from env (MCP has no CLI flags)
      const policy = resolveDownloadPolicy(process.env, {});

      // Non-TTY progress for MCP (periodic lines to stderr, not \r)
      const downloadProgress = createNonTtyProgressRenderer();

      // Create LLM adapter for embeddings
      const llm = new LlmAdapter(ctx.config);
      const embedResult = await llm.createEmbeddingPort(modelUri, {
        policy,
        onProgress: (progress) => downloadProgress("embed", progress),
      });
      if (!embedResult.ok) {
        throw new Error(
          `Failed to load embedding model: ${embedResult.error.message}. ` +
            "Ensure models are downloaded with: gno models pull"
        );
      }

      const embedPort = embedResult.value;

      try {
        // Embed query with contextual formatting
        const queryEmbedResult = await embedPort.embed(
          formatQueryForEmbedding(args.query)
        );
        if (!queryEmbedResult.ok) {
          throw new Error(queryEmbedResult.error.message);
        }
        const queryEmbedding = new Float32Array(queryEmbedResult.value);
        const dimensions = queryEmbedding.length;

        // Create vector index port
        const db = ctx.store.getRawDb();
        const vectorResult = await createVectorIndexPort(db, {
          model: modelUri,
          dimensions,
        });

        if (!vectorResult.ok) {
          throw new Error(
            `Vector index not available: ${vectorResult.error.message}. ` +
              "Run: gno embed"
          );
        }

        const vectorIndex = vectorResult.value;

        if (!vectorIndex.searchAvailable) {
          const reason = vectorIndex.loadError
            ? `sqlite-vec not loaded: ${vectorIndex.loadError}`
            : "sqlite-vec not available";
          throw new Error(
            `Vector search unavailable (${reason}). ` +
              "Ensure sqlite-vec is installed for your platform."
          );
        }

        const deps: VectorSearchDeps = {
          store: ctx.store,
          vectorIndex,
          embedPort,
          config: ctx.config,
        };

        const result = await searchVectorWithEmbedding(
          deps,
          args.query,
          queryEmbedding,
          {
            limit: args.limit ?? 5,
            minScore: args.minScore,
            collection: args.collection,
            tagsAll: normalizeTagFilters(args.tagsAll),
            tagsAny: normalizeTagFilters(args.tagsAny),
          }
        );

        if (!result.ok) {
          throw new Error(result.error.message);
        }

        // Enrich with absPath
        const enrichedResults = enrichWithAbsPath(result.value.results, ctx);

        return {
          ...result.value,
          results: enrichedResults,
          meta: {
            ...result.value.meta,
            // Add queryLanguage hint if provided (per spec, lang is a hint for vsearch)
            ...(args.lang ? { queryLanguage: args.lang } : {}),
          },
        };
      } finally {
        await embedPort.dispose();
      }
    },
    formatSearchResults
  );
}
