/** Context Capsule build command over the shared application runtime. */

import type { ContextCapsuleBuildInput } from "../../app/context-runtime";
import type { RetrievalTraceSession } from "../../core/retrieval-trace-session";
import type { EmbeddingPort, RerankPort } from "../../llm/types";
import type { VectorIndexPort } from "../../store/vector";

import { formatContextCapsuleMarkdown } from "../../app/context-format";
import {
  buildContextCapsule,
  canonicalBuiltContextCapsuleJson,
  validateContextCapsuleBuildInput,
} from "../../app/context-runtime";
import {
  finishRetrievalTraceAfterError,
  startRetrievalTraceRequest,
} from "../../core/retrieval-trace-request";
import { LlmAdapter } from "../../llm/nodeLlamaCpp/adapter";
import { resolveDownloadPolicy } from "../../llm/policy";
import { resolveModelUri } from "../../llm/registry";
import { createVectorIndexPort } from "../../store/vector";
import { CliError } from "../errors";
import { getGlobals } from "../program";
import {
  createProgressRenderer,
  createThrottledProgressRenderer,
} from "../progress";
import { initStore } from "./shared";

export interface ContextBuildCommandOptions extends Omit<
  ContextCapsuleBuildInput,
  "goal"
> {
  configPath?: string;
  format: "json" | "md";
}

const validationCodes = new Set([
  "identity_mismatch",
  "invalid_budget",
  "invalid_filter",
  "invalid_goal",
  "invalid_input",
  "invalid_uri",
]);

export const contextCliError = (error: unknown): CliError => {
  const contextCode =
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : "runtime_error";
  return new CliError(
    validationCodes.has(contextCode) ? "VALIDATION" : "RUNTIME",
    error instanceof Error ? error.message : String(error),
    { details: { contextCode } }
  );
};

// oxlint-disable-next-line max-lines-per-function -- owns one bounded model/store lifecycle
export const contextBuild = async (
  goal: string,
  options: ContextBuildCommandOptions
): Promise<string> => {
  try {
    validateContextCapsuleBuildInput({ goal, ...options }, options.indexName);
  } catch (error) {
    throw contextCliError(error);
  }
  const initResult = await initStore({
    configPath: options.configPath,
    indexName: options.indexName,
    syncConfig: true,
  });
  if (!initResult.ok) {
    throw new CliError("RUNTIME", initResult.error);
  }
  const { config, store } = initResult;
  const llm = new LlmAdapter(config);
  let embedPort: EmbeddingPort | null = null;
  let rerankPort: RerankPort | null = null;
  let vectorIndex: VectorIndexPort | null = null;
  let traceSession: RetrievalTraceSession | undefined;
  try {
    validateContextCapsuleBuildInput(
      { goal, ...options },
      options.indexName,
      config.collections.map((collection) => collection.name)
    );
    const collection =
      options.collections?.length === 1 ? options.collections[0] : undefined;
    const embedUri =
      options.depthPolicy === "fast"
        ? undefined
        : resolveModelUri(config, "embed", undefined, collection);
    const rerankUri =
      options.depthPolicy === "fast"
        ? undefined
        : resolveModelUri(config, "rerank", undefined, collection);
    const traceStart = await startRetrievalTraceRequest({
      store,
      config,
      query: options.query ?? goal,
      goal,
      filters: {
        limit: options.limit,
        collection,
        collections: [...(options.collections ?? [])].sort(),
        lang: options.lang,
        tagsAll: options.tagsAll,
        tagsAny: options.tagsAny,
        since: options.since,
        until: options.until,
        categories: options.categories,
        author: options.author,
        graph: options.graph,
        candidateLimit: options.candidateLimit,
        queryModes: options.queryModes,
        uriPrefix: options.uriPrefix ?? undefined,
      },
      pipeline: "context",
      indexName: options.indexName,
      modelUris: [embedUri, rerankUri].filter((value): value is string =>
        Boolean(value)
      ),
    });
    if (!traceStart.ok) throw new Error(traceStart.error.message);
    traceSession = traceStart.value ?? undefined;
    if (options.depthPolicy !== "fast") {
      if (!(embedUri && rerankUri)) {
        throw new Error("Context model identities could not be resolved");
      }
      const globals = getGlobals();
      const policy = resolveDownloadPolicy(process.env, {
        offline: globals.offline,
      });
      const showProgress = process.stderr.isTTY && !globals.quiet;
      const progress = showProgress
        ? createThrottledProgressRenderer(createProgressRenderer())
        : undefined;
      const embedResult = await llm.createEmbeddingPort(embedUri, {
        policy,
        onProgress: progress ? (value) => progress("embed", value) : undefined,
      });
      if (embedResult.ok) {
        embedPort = embedResult.value;
        const initialized = await embedPort.init();
        if (initialized.ok) {
          const vectorResult = await createVectorIndexPort(store.getRawDb(), {
            model: embedUri,
            dimensions: embedPort.dimensions(),
          });
          if (vectorResult.ok) vectorIndex = vectorResult.value;
        }
      }
      const rerankResult = await llm.createRerankPort(rerankUri, {
        policy,
        onProgress: progress ? (value) => progress("rerank", value) : undefined,
      });
      if (rerankResult.ok) rerankPort = rerankResult.value;
      if (showProgress && progress) process.stderr.write("\n");
    }
    const capsule = await buildContextCapsule(
      { goal, ...options },
      {
        store,
        config,
        indexName: options.indexName,
        vectorIndex,
        embedPort,
        rerankPort,
        traceSession,
      }
    );
    const finished = await traceSession?.finish("completed");
    if (finished && !finished.ok) throw new Error(finished.error.message);
    const traceMetadata = traceSession?.metadata();
    if (traceMetadata) {
      process.stderr.write(`Trace: ${traceMetadata.traceId}\n`);
    }
    return options.format === "md"
      ? formatContextCapsuleMarkdown(capsule)
      : canonicalBuiltContextCapsuleJson(capsule);
  } catch (error) {
    await finishRetrievalTraceAfterError(traceSession, error);
    if (error instanceof CliError) throw error;
    throw contextCliError(error);
  } finally {
    await embedPort?.dispose();
    await rerankPort?.dispose();
    await llm.dispose();
    await store.close();
  }
};
