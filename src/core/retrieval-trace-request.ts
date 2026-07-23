/** Surface-boundary request setup for private retrieval traces. */

import type { Config } from "../config/types";
import type { HybridSearchOptions, SearchOptions } from "../pipeline/types";
import type { StorePort, StoreResult } from "../store/types";
import type { RetrievalTraceFingerprints } from "../store/types";
import type { RetrievalTraceTerminalStatus } from "../store/types";

import { canonicalTraceJson } from "../store/retrieval-trace-codec";
import { err, ok } from "../store/types";
import { RetrievalTraceSession } from "./retrieval-trace-session";

export const retrievalTraceFailureStatus = (
  cause: unknown
): RetrievalTraceTerminalStatus => {
  if (
    cause instanceof Error &&
    (cause.name === "AbortError" ||
      (cause as Error & { code?: string }).code === "ABORT_ERR")
  ) {
    return "cancelled";
  }
  return "failed";
};

export const finishRetrievalTraceAfterError = async (
  session: RetrievalTraceSession | null | undefined,
  cause: unknown
): Promise<void> => {
  await session?.finish(retrievalTraceFailureStatus(cause));
};

const fingerprint = (value: unknown): string =>
  new Bun.CryptoHasher("sha256")
    .update(canonicalTraceJson(JSON.parse(JSON.stringify(value))))
    .digest("hex");

export const buildRetrievalTraceFingerprints = async (input: {
  store: StorePort;
  config: Config;
  pipeline: string;
  pipelineOptions?: Record<string, unknown>;
  indexName?: string;
  modelUris?: string[];
}): Promise<RetrievalTraceFingerprints> => {
  const collections = await input.store.getCollections();
  if (!collections.ok) throw new Error(collections.error.message);
  const snapshots = [];
  for (const collection of [...collections.value].sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    const snapshot = await input.store.getActivationIndexSnapshot(
      collection.name
    );
    if (!snapshot.ok) throw new Error(snapshot.error.message);
    snapshots.push({ collection: collection.name, value: snapshot.value });
  }
  return {
    pipeline: fingerprint({
      contract: "retrieval-trace-v1",
      pipeline: input.pipeline,
      ...(input.pipelineOptions ? { options: input.pipelineOptions } : {}),
    }),
    model: fingerprint(
      [...(input.modelUris ?? [])].sort((left, right) =>
        left.localeCompare(right)
      )
    ),
    config: fingerprint(input.config),
    index: fingerprint({
      indexName: input.indexName ?? "default",
      snapshots,
    }),
  };
};

/** Start a real surface session; all expensive fingerprint work stays lazy. */
export const startRetrievalTraceRequest = async (input: {
  store: StorePort;
  config: Config;
  query: string;
  goal?: string;
  filters?: Record<string, unknown>;
  pipeline: string;
  indexName?: string;
  modelUris?: string[];
}): Promise<StoreResult<RetrievalTraceSession | null>> => {
  if (input.config.retrievalTraces?.enabled !== true) return ok(null);
  try {
    return await RetrievalTraceSession.start({
      store: input.store,
      config: input.config.retrievalTraces,
      query: input.query,
      goal: input.goal,
      filters: JSON.parse(JSON.stringify(input.filters ?? {})),
      fingerprints: () => buildRetrievalTraceFingerprints(input),
    });
  } catch (cause) {
    return err(
      "QUERY_FAILED",
      cause instanceof Error
        ? `Trace fingerprinting failed: ${cause.message}`
        : "Trace fingerprinting failed",
      cause
    );
  }
};

export const retrievalTraceFilters = (
  options: SearchOptions | HybridSearchOptions
): Record<string, unknown> =>
  JSON.parse(
    JSON.stringify({
      limit: options.limit,
      minScore: options.minScore,
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
      ...("noExpand" in options
        ? {
            noExpand: options.noExpand,
            noRerank: options.noRerank,
            candidateLimit: options.candidateLimit,
            explain: options.explain,
            graph: options.graph,
            noGraph: options.noGraph,
            queryLanguageHint: options.queryLanguageHint,
            queryModes: options.queryModes,
          }
        : {}),
    })
  );
