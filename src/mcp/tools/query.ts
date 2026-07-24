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
import type { QueryDiagnoseResult } from "../../pipeline/diagnose";
import type {
  QueryModeInput,
  SearchResult,
  SearchResults,
} from "../../pipeline/types";
import type { ToolContext } from "../server";

import { decorateUriForIndex, parseUri } from "../../app/constants";
import { createNonTtyProgressRenderer } from "../../cli/progress";
import {
  fingerprintContentTypeRules,
  normalizeContentTypes,
} from "../../config";
import { resolveDepthPolicy } from "../../core/depth-policy";
import { resolveRemoteProjectAffinity } from "../../core/project-affinity-surface";
import {
  finishRetrievalTraceAfterError,
  retrievalTraceFilters,
  startRetrievalTraceRequest,
} from "../../core/retrieval-trace-request";
import {
  attachRetrievalTraceMetadata,
  type RetrievalTraceSession,
} from "../../core/retrieval-trace-session";
import { normalizeStructuredQueryInput } from "../../core/structured-query";
import { LlmAdapter } from "../../llm/nodeLlamaCpp/adapter";
import { resolveDownloadPolicy } from "../../llm/policy";
import { getActivePreset, resolveModelUri } from "../../llm/registry";
import { diagnoseQueryTarget } from "../../pipeline/diagnose";
import { type HybridSearchDeps, searchHybrid } from "../../pipeline/hybrid";
import {
  createVectorIndexPort,
  type VectorIndexPort,
} from "../../store/vector";
import { normalizeTagFilters, runTool, type ToolResult } from "./index";

interface QueryInput {
  query: string;
  projectHints?: string[];
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
  noGraph?: boolean;
  graph?: boolean;
  tagsAll?: string[];
  tagsAny?: string[];
}

interface QueryDiagnoseInput extends QueryInput {
  target: string;
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
      uri: decorateUriForIndex(r.uri, ctx.indexName),
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

function formatQueryDiagnoseResult(data: QueryDiagnoseResult): string {
  if (data.target.status !== "diagnosed") {
    return `Target ${data.target.ref}: ${data.target.status}`;
  }

  const lines = [
    `Query diagnose for ${data.target.uri ?? data.target.ref}`,
    `Mode: ${data.meta.mode}, results: ${data.meta.totalResults}`,
    "",
  ];

  for (const stage of data.stages) {
    const rank = stage.rank === null ? "-" : `#${stage.rank}`;
    const score = stage.score === null ? "-" : Number(stage.score).toFixed(3);
    const reason = stage.dropReason ? `, ${stage.dropReason}` : "";
    lines.push(
      `${stage.id}: ${stage.status}, present=${stage.present}, rank=${rank}, score=${score}${reason}`
    );
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

      let embedPort: EmbeddingPort | null = null;
      let expandPort: GenerationPort | null = null;
      let rerankPort: RerankPort | null = null;
      let vectorIndex: VectorIndexPort | null = null;
      let traceSession: RetrievalTraceSession | undefined;
      const embedUri = resolveModelUri(
        ctx.config,
        "embed",
        undefined,
        args.collection
      );
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
      const projectAffinity = await resolveRemoteProjectAffinity(
        ctx.config,
        args.projectHints
      );
      const expandUri =
        !noExpand && !hasStructuredModes
          ? resolveModelUri(ctx.config, "expand", undefined, args.collection)
          : undefined;
      const rerankUri = !noRerank
        ? resolveModelUri(ctx.config, "rerank", undefined, args.collection)
        : undefined;
      const options = {
        limit: args.limit ?? 5,
        minScore: args.minScore,
        collection: args.collection,
        queryLanguageHint: args.lang,
        intent: args.intent,
        candidateLimit: depthPolicy.candidateLimit,
        exclude: args.exclude,
        since: args.since,
        until: args.until,
        categories: args.categories,
        author: args.author,
        noExpand,
        noRerank,
        graph: args.graph === true,
        noGraph: args.noGraph || args.fast,
        queryModes,
        tagsAll: normalizeTagFilters(args.tagsAll),
        tagsAny: normalizeTagFilters(args.tagsAny),
        projectAffinity,
      };

      try {
        const traceStart = await startRetrievalTraceRequest({
          store: ctx.store,
          config: ctx.config,
          query: queryText,
          filters: retrievalTraceFilters(options),
          pipeline: "hybrid",
          indexName: ctx.indexName,
          modelUris: [embedUri, expandUri, rerankUri].filter(
            (value): value is string => Boolean(value)
          ),
        });
        if (!traceStart.ok) throw new Error(traceStart.error.message);
        traceSession = traceStart.value ?? undefined;
        const llm = new LlmAdapter(ctx.config);

        // Resolve download policy from env (MCP has no CLI flags)
        const policy = resolveDownloadPolicy(process.env, {});

        // Non-TTY progress for MCP (periodic lines to stderr, not \r)
        const downloadProgress = createNonTtyProgressRenderer();

        // Create embedding port (for vector search) - optional
        const embedResult = await llm.createEmbeddingPort(embedUri, {
          policy,
          onProgress: (progress) => downloadProgress("embed", progress),
        });
        if (embedResult.ok) {
          embedPort = embedResult.value;
        }

        // Create expansion port - optional
        if (expandUri) {
          const genResult = await llm.createExpansionPort(expandUri, {
            policy,
            onProgress: (progress) => downloadProgress("expand", progress),
          });
          if (genResult.ok) {
            expandPort = genResult.value;
          }
        }

        // Create rerank port - optional
        if (rerankUri) {
          const rerankResult = await llm.createRerankPort(rerankUri, {
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

        const result = await searchHybrid(deps, queryText, {
          ...options,
          traceSession,
        });

        if (!result.ok) {
          throw new Error(result.error.message);
        }

        // Enrich with absPath
        const enrichedResults = enrichWithAbsPath(result.value.results, ctx);

        return attachRetrievalTraceMetadata(
          {
            ...result.value,
            results: enrichedResults,
            meta: {
              ...result.value.meta,
              // Add queryLanguage hint if provided
              ...(args.lang ? { queryLanguage: args.lang } : {}),
            },
          },
          traceSession
        );
      } catch (cause) {
        await finishRetrievalTraceAfterError(traceSession, cause);
        throw cause;
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

/**
 * Handle gno_query_diagnose tool call.
 */
export function handleQueryDiagnose(
  args: QueryDiagnoseInput,
  ctx: ToolContext
): Promise<ToolResult> {
  return runTool(
    ctx,
    "gno_query_diagnose",
    // oxlint-disable-next-line max-lines-per-function -- mirrors query setup for diagnostic trace ports
    async () => {
      let collection: string | undefined;
      if (args.collection) {
        const canonical = ctx.collections.find(
          (c) => c.name.toLowerCase() === args.collection?.toLowerCase()
        );
        if (!canonical) {
          throw new Error(`Collection not found: ${args.collection}`);
        }
        collection = canonical.name;
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
      const policy = resolveDownloadPolicy(process.env, {});
      const downloadProgress = createNonTtyProgressRenderer();

      let embedPort: EmbeddingPort | null = null;
      let expandPort: GenerationPort | null = null;
      let rerankPort: RerankPort | null = null;
      let vectorIndex: VectorIndexPort | null = null;
      const embedUri = resolveModelUri(
        ctx.config,
        "embed",
        undefined,
        collection
      );

      try {
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
        const projectAffinity = await resolveRemoteProjectAffinity(
          ctx.config,
          args.projectHints
        );

        if (!args.fast) {
          const embedResult = await llm.createEmbeddingPort(embedUri, {
            policy,
            onProgress: (progress) => downloadProgress("embed", progress),
          });
          if (embedResult.ok) {
            embedPort = embedResult.value;
          }
        }

        if (!noExpand && !hasStructuredModes) {
          const genResult = await llm.createExpansionPort(
            resolveModelUri(ctx.config, "expand", undefined, collection),
            {
              policy,
              onProgress: (progress) => downloadProgress("expand", progress),
            }
          );
          if (genResult.ok) {
            expandPort = genResult.value;
          }
        }

        if (!noRerank) {
          const rerankResult = await llm.createRerankPort(
            resolveModelUri(ctx.config, "rerank", undefined, collection),
            {
              policy,
              onProgress: (progress) => downloadProgress("rerank", progress),
            }
          );
          if (rerankResult.ok) {
            rerankPort = rerankResult.value;
          }
        }

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
        const contentTypeRules = normalizeContentTypes(
          ctx.config.contentTypes ?? []
        ).rules;

        const result = await diagnoseQueryTarget(deps, queryText, {
          target: args.target,
          limit: args.limit ?? 5,
          minScore: args.minScore,
          collection,
          queryLanguageHint: args.lang,
          intent: args.intent,
          candidateLimit: depthPolicy.candidateLimit,
          exclude: args.exclude,
          since: args.since,
          until: args.until,
          categories: args.categories,
          author: args.author,
          noExpand,
          noRerank,
          graph: args.graph === true,
          noGraph: args.noGraph || args.fast,
          queryModes,
          tagsAll: normalizeTagFilters(args.tagsAll),
          tagsAny: normalizeTagFilters(args.tagsAny),
          projectAffinity,
          contentTypeRules,
          contentTypeRulesFingerprint:
            fingerprintContentTypeRules(contentTypeRules),
        });

        if (!result.ok) {
          throw new Error(result.error.message);
        }

        return result.value;
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
    formatQueryDiagnoseResult
  );
}
