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
import type { SearchResult, SearchResults } from "../../pipeline/types";
import type { ToolContext } from "../server";

import { parseUri } from "../../app/constants";
import { createNonTtyProgressRenderer } from "../../cli/progress";
import { LlmAdapter } from "../../llm/nodeLlamaCpp/adapter";
import { resolveDownloadPolicy } from "../../llm/policy";
import { getActivePreset } from "../../llm/registry";
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

      const preset = getActivePreset(ctx.config);
      const llm = new LlmAdapter(ctx.config);

      // Resolve download policy from env (MCP has no CLI flags)
      const policy = resolveDownloadPolicy(process.env, {});

      // Non-TTY progress for MCP (periodic lines to stderr, not \r)
      const downloadProgress = createNonTtyProgressRenderer();

      let embedPort: EmbeddingPort | null = null;
      let genPort: GenerationPort | null = null;
      let rerankPort: RerankPort | null = null;
      let vectorIndex: VectorIndexPort | null = null;

      try {
        // Create embedding port (for vector search) - optional
        const embedResult = await llm.createEmbeddingPort(preset.embed, {
          policy,
          onProgress: (progress) => downloadProgress("embed", progress),
        });
        if (embedResult.ok) {
          embedPort = embedResult.value;
        }

        // Determine noExpand/noRerank based on mode flags
        // Priority: fast > thorough > expand/rerank params > defaults
        // Default: noExpand=true (skip expansion), noRerank=false (with reranking)
        let noExpand = true;
        let noRerank = false;

        if (args.fast) {
          noExpand = true;
          noRerank = true;
        } else if (args.thorough) {
          noExpand = false;
          noRerank = false;
        } else {
          // Use explicit expand/rerank params if provided
          if (args.expand === true) {
            noExpand = false;
          }
          if (args.rerank === false) {
            noRerank = true;
          }
        }

        // Create generation port (for expansion) - optional
        if (!noExpand) {
          const genResult = await llm.createGenerationPort(preset.gen, {
            policy,
            onProgress: (progress) => downloadProgress("gen", progress),
          });
          if (genResult.ok) {
            genPort = genResult.value;
          }
        }

        // Create rerank port - optional
        if (!noRerank) {
          const rerankResult = await llm.createRerankPort(preset.rerank, {
            policy,
            onProgress: (progress) => downloadProgress("rerank", progress),
          });
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
              model: preset.embed,
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
          genPort,
          rerankPort,
        };

        // Note: per spec, lang is a "hint" for query, not a filter
        // Pass as queryLanguageHint to affect expansion prompt selection
        // but NOT retrieval filtering (that would be options.lang)
        const result = await searchHybrid(deps, args.query, {
          limit: args.limit ?? 5,
          minScore: args.minScore,
          collection: args.collection,
          queryLanguageHint: args.lang, // Affects expansion prompt, not retrieval
          noExpand,
          noRerank,
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
        if (genPort) {
          await genPort.dispose();
        }
        if (rerankPort) {
          await rerankPort.dispose();
        }
      }
    },
    formatSearchResults
  );
}
