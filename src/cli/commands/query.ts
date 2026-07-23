/**
 * gno query command implementation.
 * Hybrid search with expansion, fusion, and reranking.
 *
 * @module src/cli/commands/query
 */

import type { RetrievalTraceSurfaceMetadata } from "../../core/retrieval-trace-session";
import type { RetrievalTraceSession } from "../../core/retrieval-trace-session";
import type {
  EmbeddingPort,
  GenerationPort,
  RerankPort,
} from "../../llm/types";
import type { HybridSearchOptions, SearchResults } from "../../pipeline/types";

import {
  fingerprintContentTypeRules,
  normalizeContentTypes,
} from "../../config";
import {
  finishRetrievalTraceAfterError,
  retrievalTraceFilters,
  startRetrievalTraceRequest,
} from "../../core/retrieval-trace-request";
import { LlmAdapter } from "../../llm/nodeLlamaCpp/adapter";
import { resolveDownloadPolicy } from "../../llm/policy";
import { resolveModelUri } from "../../llm/registry";
import {
  diagnoseQueryTarget,
  type QueryDiagnoseResult as PipelineQueryDiagnoseResult,
} from "../../pipeline/diagnose";
import { type HybridSearchDeps, searchHybrid } from "../../pipeline/hybrid";
import {
  createVectorIndexPort,
  type VectorIndexPort,
} from "../../store/vector";
import { getGlobals } from "../program";
import {
  createProgressRenderer,
  createThrottledProgressRenderer,
} from "../progress";
import { decorateSearchResultsForIndex, initStore } from "./shared";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type QueryCommandOptions = HybridSearchOptions & {
  /** Override config path */
  configPath?: string;
  /** Index name */
  indexName?: string;
  /** Override embedding model */
  embedModel?: string;
  /** Override expansion model */
  expandModel?: string;
  /** Deprecated alias for expansion model */
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
  format: "terminal" | "json" | "files" | "csv" | "md" | "xml";
  full?: boolean;
  lineNumbers?: boolean;
  terminalLinks?: import("../format/search-results").FormatOptions["terminalLinks"];
}

export type QueryResult =
  | {
      success: true;
      data: SearchResults;
      metadata?: RetrievalTraceSurfaceMetadata;
    }
  | { success: false; error: string };

export type QueryDiagnoseCommandOptions = HybridSearchOptions & {
  target: string;
  configPath?: string;
  indexName?: string;
  embedModel?: string;
  expandModel?: string;
  genModel?: string;
  rerankModel?: string;
  json?: boolean;
};

export interface QueryDiagnoseFormatOptions {
  format: "terminal" | "json";
}

export type QueryDiagnoseResult =
  | { success: true; data: PipelineQueryDiagnoseResult }
  | { success: false; error: string };

// ─────────────────────────────────────────────────────────────────────────────
// Command Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute gno query command.
 */
// oxlint-disable-next-line max-lines-per-function -- CLI orchestration with multiple output formats
export async function query(
  queryText: string,
  options: QueryCommandOptions = {}
): Promise<QueryResult> {
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

  let embedPort: EmbeddingPort | null = null;
  let expandPort: GenerationPort | null = null;
  let rerankPort: RerankPort | null = null;
  let traceSession: RetrievalTraceSession | undefined;

  try {
    const embedUri = resolveModelUri(
      config,
      "embed",
      options.embedModel,
      options.collection
    );
    const expandUri =
      !options.noExpand && !options.queryModes?.length
        ? resolveModelUri(
            config,
            "expand",
            options.expandModel ?? options.genModel,
            options.collection
          )
        : undefined;
    const rerankUri = !options.noRerank
      ? resolveModelUri(
          config,
          "rerank",
          options.rerankModel,
          options.collection
        )
      : undefined;
    const traceStart = await startRetrievalTraceRequest({
      store,
      config,
      query: queryText,
      filters: retrievalTraceFilters({ ...options, limit }),
      pipeline: "hybrid",
      indexName: options.indexName,
      modelUris: [embedUri, expandUri, rerankUri].filter(
        (value): value is string => Boolean(value)
      ),
    });
    if (!traceStart.ok) {
      return { success: false, error: traceStart.error.message };
    }
    traceSession = traceStart.value ?? undefined;
    const llm = new LlmAdapter(config);

    // Resolve download policy from env/flags
    const globals = getGlobals();
    const policy = resolveDownloadPolicy(process.env, {
      offline: globals.offline,
    });

    // Create progress renderer for model downloads (throttled)
    const showProgress = !options.json && process.stderr.isTTY;
    const downloadProgress = showProgress
      ? createThrottledProgressRenderer(createProgressRenderer())
      : undefined;

    // Create embedding port (for vector search)
    const embedResult = await llm.createEmbeddingPort(embedUri, {
      policy,
      onProgress: downloadProgress
        ? (progress) => downloadProgress("embed", progress)
        : undefined,
    });
    if (embedResult.ok) {
      embedPort = embedResult.value;
    }

    // Create expansion port - optional.
    // Skip when structured query modes are provided.
    if (expandUri) {
      const genResult = await llm.createExpansionPort(expandUri, {
        policy,
        onProgress: downloadProgress
          ? (progress) => downloadProgress("expand", progress)
          : undefined,
      });
      if (genResult.ok) {
        expandPort = genResult.value;
      }
    }

    // Create rerank port - optional
    if (rerankUri) {
      const rerankResult = await llm.createRerankPort(rerankUri, {
        policy,
        onProgress: downloadProgress
          ? (progress) => downloadProgress("rerank", progress)
          : undefined,
      });
      if (rerankResult.ok) {
        rerankPort = rerankResult.value;
      }
    }

    // Clear progress line if shown
    if (showProgress && downloadProgress) {
      process.stderr.write("\n");
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
      expandPort,
      rerankPort,
    };
    const result = await searchHybrid(deps, queryText, {
      ...options,
      limit,
      traceSession,
    });

    if (!result.ok) {
      await traceSession?.finish("failed");
      return { success: false, error: result.error.message };
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
      error: cause instanceof Error ? cause.message : "Hybrid query failed",
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
    await store.close();
  }
}

// oxlint-disable-next-line max-lines-per-function -- mirrors query setup for diagnose-specific shared core
export async function queryDiagnose(
  queryText: string,
  options: QueryDiagnoseCommandOptions
): Promise<QueryDiagnoseResult> {
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
  let embedPort: EmbeddingPort | null = null;
  let expandPort: GenerationPort | null = null;
  let rerankPort: RerankPort | null = null;

  try {
    const globals = getGlobals();
    const policy = resolveDownloadPolicy(process.env, {
      offline: globals.offline,
    });
    const showProgress = !options.json && process.stderr.isTTY;
    const downloadProgress = showProgress
      ? createThrottledProgressRenderer(createProgressRenderer())
      : undefined;
    const shouldCreateEmbeddingPort =
      !options.noExpand || !options.noRerank || Boolean(options.graph);
    const shouldCreateAnyModel =
      shouldCreateEmbeddingPort || !options.noExpand || !options.noRerank;
    const llm = shouldCreateAnyModel ? new LlmAdapter(config) : null;

    const embedUri = shouldCreateEmbeddingPort
      ? resolveModelUri(config, "embed", options.embedModel, options.collection)
      : null;
    if (embedUri && llm) {
      const embedResult = await llm.createEmbeddingPort(embedUri, {
        policy,
        onProgress: downloadProgress
          ? (progress) => downloadProgress("embed", progress)
          : undefined,
      });
      if (embedResult.ok) {
        embedPort = embedResult.value;
      }
    }

    if (llm && !options.noExpand && !options.queryModes?.length) {
      const expandUri = resolveModelUri(
        config,
        "expand",
        options.expandModel ?? options.genModel,
        options.collection
      );
      const genResult = await llm.createExpansionPort(expandUri, {
        policy,
        onProgress: downloadProgress
          ? (progress) => downloadProgress("expand", progress)
          : undefined,
      });
      if (genResult.ok) {
        expandPort = genResult.value;
      }
    }

    if (llm && !options.noRerank) {
      const rerankUri = resolveModelUri(
        config,
        "rerank",
        options.rerankModel,
        options.collection
      );
      const rerankResult = await llm.createRerankPort(rerankUri, {
        policy,
        onProgress: downloadProgress
          ? (progress) => downloadProgress("rerank", progress)
          : undefined,
      });
      if (rerankResult.ok) {
        rerankPort = rerankResult.value;
      }
    }

    if (showProgress && downloadProgress) {
      process.stderr.write("\n");
    }

    let vectorIndex: VectorIndexPort | null = null;
    if (embedPort && embedUri) {
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

    const contentTypeRules = normalizeContentTypes(
      config.contentTypes ?? []
    ).rules;
    const deps: HybridSearchDeps = {
      store,
      config,
      vectorIndex,
      embedPort,
      expandPort,
      rerankPort,
    };
    const result = await diagnoseQueryTarget(deps, queryText, {
      ...options,
      contentTypeRules,
      contentTypeRulesFingerprint:
        fingerprintContentTypeRules(contentTypeRules),
    });

    if (!result.ok) {
      return { success: false, error: result.error.message };
    }
    return { success: true, data: result.value };
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
  } = require("../../pipeline/explain");
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
    return options.format === "json"
      ? JSON.stringify({
          error: { code: "QUERY_FAILED", message: result.error },
        })
      : `Error: ${result.error}`;
  }
  // Output explain to stderr if present (async but best-effort)
  outputExplainToStderr(result.data);

  // Use shared formatter for consistent output
  // Dynamic import to keep module loading fast
  const { formatSearchResults } = require("../format/search-results");
  return formatSearchResults(result.data, {
    format: options.format,
    full: options.full,
    lineNumbers: options.lineNumbers,
    terminalLinks: options.terminalLinks,
  });
}

export function formatQueryDiagnose(
  result: QueryDiagnoseResult,
  options: QueryDiagnoseFormatOptions
): string {
  if (!result.success) {
    return options.format === "json"
      ? JSON.stringify({
          error: { code: "QUERY_DIAGNOSE_FAILED", message: result.error },
        })
      : `Error: ${result.error}`;
  }

  if (options.format === "json") {
    return JSON.stringify(result.data, null, 2);
  }

  const target = result.data.target;
  const lines = [
    `Target: ${target.uri ?? target.ref}`,
    `Status: ${target.status}`,
    `Mode: ${result.data.meta.mode}`,
  ];
  if (target.filterReasons.length > 0) {
    lines.push(`Filters: ${target.filterReasons.join(", ")}`);
  }
  if (target.graphHints.length > 0) {
    lines.push(`Graph hints: ${target.graphHints.join(", ")}`);
  }
  if (result.data.stages.length > 0) {
    lines.push("", "Stages:");
    for (const stage of result.data.stages) {
      const rank = stage.rank === null ? "-" : `#${stage.rank}`;
      const score = stage.score === null ? "-" : stage.score.toFixed(4);
      const reason = stage.dropReason ? ` ${stage.dropReason}` : "";
      lines.push(
        `  ${stage.id}: ${stage.status} present=${stage.present} rank=${rank} score=${score}${reason}`
      );
    }
  }
  return lines.join("\n");
}
