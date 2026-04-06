/**
 * MCP gno_query tool - Hybrid search with expansion and reranking.
 *
 * @module src/mcp/tools/query
 */

import { join as pathJoin } from "node:path";

import type {
  EmbeddingPort,
  GenerationPort,
  RerankPort,
} from "../../llm/types";
import type {
  QueryModeInput,
  SearchResult,
  SearchResults,
} from "../../pipeline/types";
import type { ToolContext } from "../server";

import { parseUri } from "../../app/constants";
import { createNonTtyProgressRenderer } from "../../cli/progress";
import { resolveDepthPolicy } from "../../core/depth-policy";
import { normalizeStructuredQueryInput } from "../../core/structured-query";
import { LlmAdapter } from "../../llm/nodeLlamaCpp/adapter";
import { resolveDownloadPolicy } from "../../llm/policy";
import { getActivePreset, resolveModelUri } from "../../llm/registry";
import { type HybridSearchDeps, searchHybrid } from "../../pipeline/hybrid";
import {
  createVectorIndexPort,
  type VectorIndexPort,
} from "../../store/vector";
import { normalizeTagFilters, runTool, type ToolResult } from "./index";

interface QueryInput {
  query: string;
  collection?: string;
  limit?: number;
  minScore?: number;
  lang?: string;
  intent?: string;
  candidateLimit?: number;
  exclude?: string[];
  since?: string;
  until?: string;
  categories?: string[];
  author?: string;
  queryModes?: QueryModeInput[];
  fast?: boolean;
  thorough?: boolean;
  expand?: boolean;
  rerank?: boolean;
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
  const mode = data.meta.mode === "bm25_only" ? "BM25 only" : "hybrid";
  const flags: string[] = [];
  if (data.meta.expanded) {
    flags.push("expanded");
  }
  if (data.meta.reranked) {
    flags.push("reranked");
  }
  if (data.meta.vectorsUsed) {
    flags.push("vectors");
  }

  lines.push(
    `Found ${data.results.length} results for "${data.meta.query}" (${mode}${flags.length > 0 ? `, ${flags.join(", ")}` : ""}):`
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
 * Handle gno_query tool call.
 */
export function handleQuery(
  args: QueryInput,
  ctx: ToolContext
): Promise<ToolResult> {
  return runTool(
    ctx,
    "gno_query",
    // oxlint-disable-next-line max-lines-per-function -- query with validation and result formatting
    async () => {
      // Validate collection exists if specified
      if (args.collection) {
        const exists = ctx.collections.some((c) => c.name === args.collection);
        if (!exists) {
          throw new Error(`Collection not found: ${args.collection}`);
        }
      }

      const normalizedInput = normalizeStructuredQueryInput(
        args.query,
        args.queryModes ?? []
      );
      if (!normalizedInput.ok) {
        throw new Error(normalizedInput.error.message);
      }
      const queryText = normalizedInput.value.query;
      const queryModes =
        normalizedInput.value.queryModes.length > 0
          ? normalizedInput.value.queryModes
          : undefined;

      const preset = getActivePreset(ctx.config);
      const llm = new LlmAdapter(ctx.config);

      // Resolve download policy from env (MCP has no CLI flags)
      const policy = resolveDownloadPolicy(process.env, {});

      // Non-TTY progress for MCP (periodic lines to stderr, not \r)
      const downloadProgress = createNonTtyProgressRenderer();

      let embedPort: EmbeddingPort | null = null;
      let expandPort: GenerationPort | null = null;
      let rerankPort: RerankPort | null = null;
      let vectorIndex: VectorIndexPort | null = null;
      const embedUri = resolveModelUri(
        ctx.config,
        "embed",
        undefined,
        args.collection
      );

      try {
        // Create embedding port (for vector search) - optional
        const embedResult = await llm.createEmbeddingPort(embedUri, {
          policy,
          onProgress: (progress) => downloadProgress("embed", progress),
        });
        if (embedResult.ok) {
          embedPort = embedResult.value;
        }

        const hasStructuredModes = Boolean(queryModes?.length);
        const depthPolicy = resolveDepthPolicy({
          presetId: preset.id,
          fast: args.fast,
          thorough: args.thorough,
          expand: args.expand,
          rerank: args.rerank,
          candidateLimit: args.candidateLimit,
          hasStructuredModes,
        });
        const { noExpand, noRerank } = depthPolicy;

        // Create expansion port - optional
        if (!noExpand && !hasStructuredModes) {
          const genResult = await llm.createExpansionPort(
            resolveModelUri(ctx.config, "expand", undefined, args.collection),
            {
              policy,
              onProgress: (progress) => downloadProgress("expand", progress),
            }
          );
          if (genResult.ok) {
            expandPort = genResult.value;
          }
        }

        // Create rerank port - optional
        if (!noRerank) {
          const rerankResult = await llm.createRerankPort(
            resolveModelUri(ctx.config, "rerank", undefined, args.collection),
            {
              policy,
              onProgress: (progress) => downloadProgress("rerank", progress),
            }
          );
          if (rerankResult.ok) {
            rerankPort = rerankResult.value;
          }
        }

        // Create vector index (optional)
        if (embedPort) {
          const embedInitResult = await embedPort.init();
          if (embedInitResult.ok) {
            const dimensions = embedPort.dimensions();
            const db = ctx.store.getRawDb();
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
          store: ctx.store,
          config: ctx.config,
          vectorIndex,
          embedPort,
          expandPort,
          rerankPort,
        };

        // Note: per spec, lang is a "hint" for query, not a filter
        // Pass as queryLanguageHint to affect expansion prompt selection
        // but NOT retrieval filtering (that would be options.lang)
        const result = await searchHybrid(deps, queryText, {
          limit: args.limit ?? 5,
          minScore: args.minScore,
          collection: args.collection,
          queryLanguageHint: args.lang, // Affects expansion prompt, not retrieval
          intent: args.intent,
          candidateLimit: depthPolicy.candidateLimit,
          exclude: args.exclude,
          since: args.since,
          until: args.until,
          categories: args.categories,
          author: args.author,
          noExpand,
          noRerank,
          queryModes,
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
          meta: {
            ...result.value.meta,
            // Add queryLanguage hint if provided
            ...(args.lang ? { queryLanguage: args.lang } : {}),
          },
        };
      } finally {
        if (embedPort) {
          await embedPort.dispose();
        }
        if (expandPort) {
          await expandPort.dispose();
        }
        if (rerankPort) {
          await rerankPort.dispose();
        }
      }
    },
    formatSearchResults
  );
}
