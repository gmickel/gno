import type { SearchResults, AskResult } from "../../src/pipeline/types";
/** Real cached-model SDK execution and lossless acceptance projection. */
import type { GnoClientInitOptions, GnoAskOptions } from "../../src/sdk/types";
import type { ChildEvent } from "./child-receipt";

import {
  CITATION_TRACE_METADATA,
  SEARCH_RESULT_PLANNER_METADATA,
  SEARCH_RESULTS_TRACE_METADATA,
} from "../../src/pipeline/types";
import { createGnoClient } from "../../src/sdk/client";
import { exactJson, type NativeCapture } from "./capture-contract";
import {
  acceptanceManifestFingerprint,
  ACCEPTANCE_SCHEMA_VERSION,
  type AcceptanceManifest,
} from "./manifest";
import { hasNativeWorker, installParentCapture } from "./parent-capture";
import {
  acceptanceRecordSchema,
  type AcceptanceRecord,
  type DeterministicRecord,
} from "./records";

export interface AdapterRequest {
  manifest: AcceptanceManifest;
  caseId: string;
  query: string;
  operation: "hybrid" | "verified-ask";
  options: GnoAskOptions;
  expectedBackend: "cuda" | "metal";
}
export interface AdapterResult {
  record: AcceptanceRecord;
  receipt: NativeCapture;
  coverage: "complete" | "incomplete";
  reasons: string[];
  raw: unknown;
}
export type EvidenceReader = (
  uri: string
) => Promise<{ content: string; sourceHash: string }>;

// Public objects have optional undefined properties. This projection omits absent
// fields only; model arguments use captureArguments and preserve undefined.
function jsonObject(
  value: object
): Record<string, ReturnType<typeof exactJson>> {
  return exactJson(JSON.parse(JSON.stringify(value))) as Record<
    string,
    ReturnType<typeof exactJson>
  >;
}

export async function projectAcceptance(
  request: AdapterRequest,
  raw: SearchResults | AskResult | null,
  receipt: NativeCapture,
  readEvidence: EvidenceReader,
  failure?: string
): Promise<AdapterResult> {
  const reasons = [...receipt.errors, ...(failure ? [failure] : [])];
  const manifestCase = request.manifest.cases.find(
    (item) => item.caseId === request.caseId
  );
  if (!manifestCase)
    throw new Error(`Unknown acceptance case: ${request.caseId}`);
  const pinnedOptions = manifestCase.configuration.options;
  // Embedding-only coverage is a separately pinned pipeline, never an implicit
  // fast-preset exception or evidence that the default reranked suite passed.
  const rerankDisabled =
    request.options.noRerank === true &&
    pinnedOptions !== null &&
    typeof pinnedOptions === "object" &&
    !Array.isArray(pinnedOptions) &&
    pinnedOptions.noRerank === true;
  if (receipt.kind !== "native")
    reasons.push("replay_is_not_native_acceptance");
  if (
    !receipt.backends.includes(request.expectedBackend) ||
    receipt.backends.some((backend) => backend !== request.expectedBackend)
  )
    reasons.push(`native_backend_unavailable:${request.expectedBackend}`);
  for (const role of request.operation === "verified-ask"
    ? (["embedding", "reranking", "generation"] as const)
    : (["embedding", "reranking"] as const)) {
    if (role === "reranking" && rerankDisabled) continue;
    if (!receipt.modelInputs.some((input) => input.role === role))
      reasons.push(`model_not_exercised:${role}`);
  }
  for (const input of receipt.modelInputs) {
    const pin = request.manifest.models.find(
      (model) => model.role === input.role && model.id === input.modelId
    );
    if (
      !pin ||
      !receipt.models.some(
        (model) => model.id === pin.id && model.sha256 === pin.sha256
      )
    )
      reasons.push(`model_identity_unverified:${input.modelId}`);
  }
  const trace =
    raw && SEARCH_RESULTS_TRACE_METADATA in raw
      ? raw[SEARCH_RESULTS_TRACE_METADATA]
      : undefined;
  const capabilities = trace?.capabilityOutcomes ?? receipt.capabilities;
  const vector = capabilities.findLast(
    (item) => item.capability === "semantic_search"
  );
  const vectorStatus =
    vector?.status === "used"
      ? "used"
      : vector?.status === "failed"
        ? "error"
        : "unavailable";
  if (vectorStatus !== "used") reasons.push("vector_stage_unavailable");
  if (!raw?.meta.vectorsUsed) reasons.push("vectors_not_used");
  if (!rerankDisabled && !raw?.meta.reranked)
    reasons.push("reranking_not_used");
  const verification =
    raw && "verification" in raw ? raw.verification : undefined;
  if (
    request.operation === "verified-ask" &&
    verification?.semantic.status !== "completed"
  )
    reasons.push("verification_incomplete");
  const results: DeterministicRecord["results"] = [];
  const citations: DeterministicRecord["citations"] = [];
  try {
    for (const result of raw?.results ?? []) {
      const source = await readEvidence(result.uri);
      const planner = result[SEARCH_RESULT_PLANNER_METADATA];
      const range =
        planner?.startLine && planner.endLine
          ? { startLine: planner.startLine, endLine: planner.endLine }
          : result.snippetRange;
      if (!range)
        throw new Error(`Missing selected passage coordinates: ${result.uri}`);
      const explanation = raw?.meta.explain?.results.find(
        (item) => item.docid === result.docid
      );
      const scores = Object.fromEntries(
        Object.entries(explanation ?? {}).filter(
          ([key, value]) => key.endsWith("Score") && typeof value === "number"
        )
      ) as Record<string, number>;
      results.push({
        uri: result.uri,
        score: result.score,
        scores,
        passage: {
          uri: result.uri,
          sourceHash: source.sourceHash,
          ...range,
          text: source.content
            .split("\n")
            .slice(range.startLine - 1, range.endLine)
            .join("\n"),
          provenance: jsonObject({ conversion: result.conversion, planner }),
        },
        provenance: jsonObject(result),
      });
    }
    if (raw && "citations" in raw)
      for (const citation of raw.citations ?? []) {
        const source = await readEvidence(citation.uri);
        if (!citation.startLine || !citation.endLine)
          throw new Error(`Missing citation coordinates: ${citation.uri}`);
        citations.push({
          uri: citation.uri,
          sourceHash: source.sourceHash,
          startLine: citation.startLine,
          endLine: citation.endLine,
          text: source.content
            .split("\n")
            .slice(citation.startLine - 1, citation.endLine)
            .join("\n"),
          provenance: jsonObject({
            ...citation,
            trace: citation[CITATION_TRACE_METADATA],
          }),
        });
      }
  } catch (error) {
    reasons.push(error instanceof Error ? error.message : String(error));
  }
  if (!results.length && !verification?.capsule.evidence.length)
    reasons.push("empty_successful_result");
  // These exact hybrid trace outcomes describe caller-disabled optional work,
  // not a failed attempt. No other unavailable/failed capability is exempt.
  const disabledOptionalStages = capabilities.filter(
    (item) =>
      item.status === "unavailable" &&
      ((item.capability === "query_expansion" &&
        item.reasonCode === "expansion_disabled" &&
        request.options.noExpand === true) ||
        (item.capability === "graph_expansion" &&
          item.reasonCode === "graph_disabled" &&
          request.options.graph === false) ||
        (item.capability === "reranking" &&
          item.reasonCode === "rerank_disabled" &&
          rerankDisabled))
  );
  const fallbacks = [
    ...(trace?.fallbackCodes ?? []).filter(
      (code) => !disabledOptionalStages.some((item) => item.reasonCode === code)
    ),
    ...capabilities.filter(
      (item) =>
        (item.status === "failed" || item.status === "unavailable") &&
        !disabledOptionalStages.includes(item)
    ),
  ];
  if (fallbacks.length) reasons.push("native_fallback");
  // The capability schema has exactly one elapsed-clock field. Preserve all
  // verdicts, claims, provenance and source timestamps; `raw` stays untouched.
  const verificationProjection = verification
    ? (() => {
        const { durationMs, ...semantic } = verification.semantic;
        return { deterministic: { ...verification, semantic }, durationMs };
      })()
    : null;
  const record = acceptanceRecordSchema.parse({
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    manifestSha256: acceptanceManifestFingerprint(request.manifest),
    caseId: request.caseId,
    deterministic: {
      scope: {
        query: request.query,
        operation: request.operation,
        options: jsonObject(request.options),
        surface: manifestCase.surface,
        preset: manifestCase.preset,
      },
      results,
      citations,
      modelInputs: receipt.modelInputs,
      semanticState: {
        status: reasons.length ? "incomplete" : "ok",
        vectorsUsed: raw?.meta.vectorsUsed ?? false,
        vectorStatus,
        error: reasons.length ? reasons : null,
        fallbacks,
        verification: verificationProjection
          ? jsonObject(verificationProjection.deterministic)
          : null,
      },
    },
    generatedAnswer: raw && "answer" in raw ? (raw.answer ?? null) : null,
    transport: verificationProjection
      ? { verificationSemanticDurationMs: verificationProjection.durationMs }
      : {},
  });
  return {
    record,
    receipt,
    coverage: reasons.length ? "incomplete" : "complete",
    reasons,
    raw,
  };
}

export type NativeAcceptanceInit = GnoClientInitOptions & {
  dbPath: string;
  config: NonNullable<GnoClientInitOptions["config"]>;
};

/** Retain this session for warm/post-idle strata; close explicitly at block end.
 * One capture owner per process. Calls on a session must not overlap. */
export async function createNativeAcceptanceSession(
  manifest: AcceptanceManifest,
  init: NativeAcceptanceInit,
  captureOptions?: { directory: string; onChild?: (event: ChildEvent) => void }
) {
  const childMode = await hasNativeWorker();
  if (childMode && !captureOptions)
    throw new Error("Child acceptance requires an owned capture directory");
  const parentSession = childMode
    ? await installParentCapture(
        crypto.randomUUID(),
        manifest.models,
        captureOptions!.directory,
        undefined,
        captureOptions!.onChild
      )
    : undefined;
  const session =
    parentSession ??
    (await import("./native-capture")).installNativeCapture(
      crypto.randomUUID(),
      manifest.models
    );
  let client: Awaited<ReturnType<typeof createGnoClient>>;
  try {
    client = await createGnoClient({
      ...init,
      downloadPolicy: { offline: true, allowDownload: false },
    });
  } catch (error) {
    session.restore();
    throw error;
  }
  let busy = false;
  let closed = false;
  return {
    modelState: () => parentSession?.modelState(),
    async run(
      request: AdapterRequest,
      options: { prepareEmbeddings?: boolean } = {}
    ): Promise<AdapterResult> {
      if (closed || busy) throw new Error("Native session closed or busy");
      if (
        acceptanceManifestFingerprint(request.manifest) !==
        acceptanceManifestFingerprint(manifest)
      )
        throw new Error("Native session manifest mismatch");
      if (
        manifest.cases.find((item) => item.caseId === request.caseId)
          ?.surface !== "sdk"
      )
        throw new Error("Native SDK adapter requires an sdk case");
      busy = true;
      parentSession?.begin(request.caseId);
      session.capture.modelInputs = [];
      session.capture.modelOutputs = [];
      session.capture.capabilities = [];
      session.capture.errors = [];
      let raw: SearchResults | AskResult | null = null;
      let failure: string | undefined;
      try {
        try {
          if (options.prepareEmbeddings)
            await client.embed({ collection: request.options.collection });
          raw =
            request.operation === "verified-ask"
              ? await client.ask(request.query, {
                  ...request.options,
                  verify: true,
                  explain: true,
                })
              : await client.query(request.query, {
                  ...request.options,
                  explain: true,
                });
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
        parentSession?.finish();
        return await projectAcceptance(
          request,
          raw,
          structuredClone(session.capture),
          async (uri) => {
            const document = await client.get(uri);
            if (!document.source.sourceHash)
              throw new Error(`Missing source hash: ${uri}`);
            return {
              content: document.content,
              sourceHash: document.source.sourceHash,
            };
          },
          failure
        );
      } finally {
        busy = false;
      }
    },
    async close(): Promise<void> {
      if (busy) throw new Error("Cannot close a running native session");
      if (closed) return;
      closed = true;
      try {
        await client.close();
      } finally {
        session.restore();
      }
    },
  };
}

/** Fresh-client convenience. Do not label repeated calls as resident warm. */
export async function runNativeAcceptance(
  request: AdapterRequest,
  init: NativeAcceptanceInit,
  options: { prepareEmbeddings?: boolean; captureDirectory?: string } = {}
): Promise<AdapterResult> {
  let session: Awaited<ReturnType<typeof createNativeAcceptanceSession>>;
  try {
    session = await createNativeAcceptanceSession(
      request.manifest,
      init,
      options.captureDirectory
        ? { directory: options.captureDirectory }
        : undefined
    );
  } catch (error) {
    return projectAcceptance(
      request,
      null,
      {
        runId: crypto.randomUUID(),
        kind: "native",
        modelInputs: [],
        modelOutputs: [],
        backends: [],
        models: [],
        capabilities: [],
        errors: [],
      },
      async () => {
        throw new Error("SDK unavailable");
      },
      error instanceof Error ? error.message : String(error)
    );
  }
  try {
    return await session.run(request, options);
  } finally {
    await session.close();
  }
}

/** Replay exercises serialization/comparison only and cannot mint native coverage. */
export function replayAcceptance(value: AdapterResult): AdapterResult {
  const replay = structuredClone(value);
  replay.receipt.kind = "replay";
  replay.coverage = "incomplete";
  replay.reasons.push("replay_is_not_native_acceptance");
  replay.record.deterministic.semanticState.status = "incomplete";
  replay.record.deterministic.semanticState.error = [...replay.reasons];
  return replay;
}
