/**
 * gno ask command implementation.
 * Human-friendly query with citations and optional grounded answer.
 *
 * @module src/cli/commands/ask
 */

import type { RetrievalTraceSurfaceMetadata } from "../../core/retrieval-trace-session";
import type { RetrievalTraceSession } from "../../core/retrieval-trace-session";
import type {
  EmbeddingPort,
  GenerationPort,
  RerankPort,
} from "../../llm/types";
import type { AskOptions, AskResult, Citation } from "../../pipeline/types";

import { buildVerifiedAsk } from "../../app/verified-ask";
import {
  finishRetrievalTraceAfterError,
  retrievalTraceFilters,
  startRetrievalTraceRequest,
} from "../../core/retrieval-trace-request";
import { LlmAdapter } from "../../llm/nodeLlamaCpp/adapter";
import { resolveDownloadPolicy } from "../../llm/policy";
import { resolveModelUri } from "../../llm/registry";
import {
  answerTraceTerminalStatus,
  generateGroundedAnswer,
  processAnswerResultWithTrace,
} from "../../pipeline/answer";
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
import { initStore } from "./shared";

export { formatAsk } from "./ask-format";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type AskCommandOptions = AskOptions & {
  /** Override config path */
  configPath?: string;
  /** Override embedding model */
  embedModel?: string;
  /** Override expansion model */
  expandModel?: string;
  /** Override answer generation model */
  genModel?: string;
  /** Override rerank model */
  rerankModel?: string;
  /** Output as JSON */
  json?: boolean;
  /** Output as Markdown */
  md?: boolean;
  /** Show all retrieved sources (not just cited) */
  showSources?: boolean;
};

export type AskCommandResult =
  | {
      success: true;
      data: AskResult;
      metadata?: RetrievalTraceSurfaceMetadata;
    }
  | { success: false; error: string };

// ─────────────────────────────────────────────────────────────────────────────
// Command Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute gno ask command.
 */
// oxlint-disable-next-line max-lines-per-function -- CLI orchestration with multiple output formats
export async function ask(
  query: string,
  options: AskCommandOptions = {}
): Promise<AskCommandResult> {
  const limit = options.limit ?? 5;
  const globals = getGlobals();

  const initResult = await initStore({
    configPath: options.configPath,
    indexName: globals.index,
    collection: options.collection,
    syncConfig: false,
  });

  if (!initResult.ok) {
    return { success: false, error: initResult.error };
  }

  const { store, config } = initResult;

  let embedPort: EmbeddingPort | null = null;
  let expandPort: GenerationPort | null = null;
  let answerPort: GenerationPort | null = null;
  let rerankPort: RerankPort | null = null;
  let traceSession: RetrievalTraceSession | undefined;

  try {
    const verificationRequested = options.verify === true;
    const answerRequested =
      verificationRequested || Boolean(options.answer && !options.noAnswer);
    const embedUri = resolveModelUri(
      config,
      "embed",
      options.embedModel,
      options.collection
    );
    const expandUri =
      !verificationRequested && !options.noExpand && !options.queryModes?.length
        ? resolveModelUri(
            config,
            "expand",
            options.expandModel ?? options.genModel,
            options.collection
          )
        : undefined;
    const answerUri = answerRequested
      ? resolveModelUri(config, "gen", options.genModel, options.collection)
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
      query,
      filters: retrievalTraceFilters({ ...options, limit }),
      pipeline: "ask",
      indexName: globals.index,
      modelUris: [embedUri, expandUri, answerUri, rerankUri].filter(
        (value): value is string => Boolean(value)
      ),
    });
    if (!traceStart.ok) {
      return { success: false, error: traceStart.error.message };
    }
    traceSession = traceStart.value ?? undefined;
    const llm = new LlmAdapter(config);

    // Resolve download policy from env/flags
    const policy = resolveDownloadPolicy(process.env, {
      offline: globals.offline,
    });

    // Create progress renderer for model downloads (throttled)
    const showProgress = !options.json && process.stderr.isTTY;
    const downloadProgress = showProgress
      ? createThrottledProgressRenderer(createProgressRenderer())
      : undefined;

    // Create embedding port
    const embedResult = await llm.createEmbeddingPort(embedUri, {
      policy,
      onProgress: downloadProgress
        ? (progress) => downloadProgress("embed", progress)
        : undefined,
    });
    if (embedResult.ok) {
      embedPort = embedResult.value;
    }

    // Create expansion port when expansion is enabled.
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

    // Create answer generation port when answers are requested.
    if (answerUri) {
      const genResult = await llm.createGenerationPort(answerUri, {
        policy,
        onProgress: downloadProgress
          ? (progress) => downloadProgress("gen", progress)
          : undefined,
      });
      if (genResult.ok) {
        answerPort = genResult.value;
      }
    }

    // Create rerank port (unless --fast or --no-rerank)
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

    // Create vector index
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
    // Fail early if --answer is requested but no generation model available
    if (answerRequested && answerPort === null) {
      await traceSession?.recordCapability(
        "answer_generation",
        "unavailable",
        "model_unavailable"
      );
      await traceSession?.finish("failed");
      return {
        success: false,
        error:
          "Answer generation requested but no generation model available. " +
          "Run `gno models pull --gen` to download a model, or configure a preset.",
      };
    }

    if (verificationRequested && answerPort) {
      const verified = await buildVerifiedAsk(
        query,
        { ...options, limit },
        {
          store,
          config,
          indexName: globals.index,
          vectorIndex,
          embedPort,
          rerankPort,
          genPort: answerPort,
          traceSession,
        }
      );
      const finalized = await traceSession?.finish(
        answerTraceTerminalStatus(verified.citations)
      );
      if (finalized && !finalized.ok) {
        return { success: false, error: finalized.error.message };
      }
      return {
        success: true,
        data: verified,
        metadata: traceSession?.metadata(),
      };
    }

    // Run hybrid search
    const searchResult = await searchHybrid(deps, query, {
      limit,
      collection: options.collection,
      lang: options.lang,
      intent: options.intent,
      since: options.since,
      until: options.until,
      categories: options.categories,
      author: options.author,
      tagsAll: options.tagsAll,
      tagsAny: options.tagsAny,
      exclude: options.exclude,
      minScore: options.minScore,
      graph: options.graph,
      queryModes: options.queryModes,
      noExpand: options.noExpand,
      noRerank: options.noRerank,
      candidateLimit: options.candidateLimit,
      traceSession,
    });

    if (!searchResult.ok) {
      await traceSession?.finish("failed");
      return { success: false, error: searchResult.error.message };
    }

    const results = searchResult.value.results;

    // Generate grounded answer if requested
    let answer: string | undefined;
    let citations: Citation[] | undefined;
    let answerContext: AskResult["meta"]["answerContext"] | undefined;
    let answerGenerated = false;

    // Only generate answer if:
    // 1. --answer was explicitly requested (not just default behavior)
    // 2. --no-answer was not set
    // 3. We have results to ground on (no point generating from nothing)
    const shouldGenerateAnswer =
      answerRequested && answerPort !== null && results.length > 0;

    if (shouldGenerateAnswer && answerPort) {
      await traceSession?.recordCapability("answer_generation", "attempted");
      const maxTokens = options.maxAnswerTokens ?? 512;
      const rawResult = await generateGroundedAnswer(
        { genPort: answerPort, store },
        query,
        results,
        maxTokens
      );

      // Fail loudly if generation was requested but failed
      if (!rawResult) {
        await traceSession?.recordCapability(
          "answer_generation",
          "failed",
          "generation_failed"
        );
        await traceSession?.finish("failed");
        return {
          success: false,
          error:
            "Answer generation failed. The generation model may have encountered an error.",
        };
      }
      await traceSession?.recordCapability("answer_generation", "used");

      // Process answer: extract valid citations, filter, renumber
      const processed = await processAnswerResultWithTrace(
        rawResult,
        traceSession
      );
      answer = processed.answer;
      citations = processed.citations;
      answerContext = processed.answerContext;
      answerGenerated = true;
    }

    const askResult: AskResult = {
      query,
      mode: searchResult.value.meta.vectorsUsed ? "hybrid" : "bm25_only",
      queryLanguage: searchResult.value.meta.queryLanguage ?? "und",
      answer,
      citations,
      results,
      meta: {
        expanded: searchResult.value.meta.expanded ?? false,
        reranked: searchResult.value.meta.reranked ?? false,
        vectorsUsed: searchResult.value.meta.vectorsUsed ?? false,
        intent: searchResult.value.meta.intent,
        candidateLimit: searchResult.value.meta.candidateLimit,
        exclude: searchResult.value.meta.exclude,
        queryModes: searchResult.value.meta.queryModes,
        answerGenerated,
        totalResults: results.length,
        answerContext,
      },
    };

    if (answerRequested) {
      if (!answerGenerated) {
        await traceSession?.recordCapability(
          "answer_generation",
          "unavailable",
          "no_evidence"
        );
      }
      const finalized = await traceSession?.finish(
        answerTraceTerminalStatus(citations)
      );
      if (finalized && !finalized.ok) {
        return { success: false, error: finalized.error.message };
      }
    }
    return {
      success: true,
      data: askResult,
      metadata: traceSession?.metadata(),
    };
  } catch (cause) {
    await finishRetrievalTraceAfterError(traceSession, cause);
    return {
      success: false,
      error: cause instanceof Error ? cause.message : "Ask failed",
    };
  } finally {
    if (embedPort) {
      await embedPort.dispose();
    }
    if (expandPort) {
      await expandPort.dispose();
    }
    if (answerPort) {
      await answerPort.dispose();
    }
    if (rerankPort) {
      await rerankPort.dispose();
    }
    await store.close();
  }
}
