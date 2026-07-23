/** Read-only comparison of persisted retrieval baselines with one candidate. */

import type { SearchResult } from "../pipeline/types";
import type { DocumentRow, StoreResult } from "../store/types";
import type {
  RetrievalQrelsCase,
  RetrievalQrel,
  RetrievalQrelsEvidence,
} from "./retrieval-qrels";
import type { RetrievalReplayDeps } from "./retrieval-replay-candidate";
import type {
  ReplayRetrievalTraceInput,
  ReplayRetrievalTraceResult,
  RetrievalReplayCandidate,
  RetrievalReplayCaseResult,
  RetrievalReplayQrelResult,
  RetrievalReplayReason,
  RetrievalReplaySourceState,
} from "./retrieval-replay-types";

import { parseUri } from "../app/constants";
import { computeRetrievalMetrics } from "../bench/metrics";
import { diagnoseQueryTarget } from "../pipeline/diagnose";
import { hashTraceCanonical } from "../store/retrieval-trace-codec";
import { ok } from "../store/types";
import { buildRetrievalQrelsArtifact } from "./retrieval-qrels";
import {
  buildRetrievalReplaySearchOptions,
  retrievalReplayLimit,
  retrievalReplayTraceMetadata,
  runRetrievalReplayCandidate,
} from "./retrieval-replay-candidate";
import { parseReplayRetrievalTraceInput } from "./retrieval-replay-validation";
import { buildRetrievalTraceFingerprints } from "./retrieval-trace-request";

export type { RetrievalReplayDeps } from "./retrieval-replay-candidate";
export { buildRetrievalReplaySearchOptions } from "./retrieval-replay-candidate";

const failedCandidateMetrics = () => ({
  precisionAtK: 0,
  recallAtK: 0,
  f1AtK: 0,
  mrr: 0,
  ndcgAtK: 0,
});

const unreplayable = (
  input: ReplayRetrievalTraceInput,
  reason: RetrievalReplayReason
): ReplayRetrievalTraceResult => ({
  schemaVersion: "1.0",
  exportId: input.exportId,
  candidate: input.candidate,
  verdict: "unreplayable",
  reason,
  recommendation: "manual_review",
  applied: false,
  cases: [],
});

const RECONSTRUCTION_REASONS = [
  "redaction_incompatible",
  "query_missing",
  "filters_incomplete",
  "no_retrieval_run",
  "ambiguous_missing_expected_run",
] as const satisfies readonly RetrievalReplayReason[];

const reconstructionReason = (message: string): RetrievalReplayReason | null =>
  RECONSTRUCTION_REASONS.find(
    (reason) =>
      message === reason ||
      message.startsWith(`${reason}:`) ||
      message.includes(`${reason}:`)
  ) ?? null;

const targetMatchesResult = (
  qrel: RetrievalQrel,
  result: SearchResult
): boolean => {
  if (qrel.target.sourceHash) {
    return qrel.target.sourceHash === result.source.sourceHash;
  }
  if (qrel.target.docid) return qrel.target.docid === result.docid;
  return qrel.target.uri === result.uri;
};

const targetMatchesEvidence = (
  qrel: RetrievalQrel,
  evidence: RetrievalQrelsEvidence
): boolean =>
  qrel.target.sourceHash
    ? qrel.target.sourceHash === evidence.sourceHash
    : qrel.target.docid
      ? qrel.target.docid === evidence.docid
      : qrel.target.uri === evidence.uri;

const resolveDocument = async (
  deps: RetrievalReplayDeps,
  qrel: RetrievalQrel,
  documents: DocumentRow[]
): Promise<StoreResult<DocumentRow | null>> => {
  if (qrel.target.sourceHash) {
    const matching = documents.filter(
      (document) => document.sourceHash === qrel.target.sourceHash
    );
    const active = matching.find((document) => document.active);
    if (active) return ok(active);
    if (matching[0]) return ok(matching[0]);
  }
  if (qrel.target.docid) {
    const byDocid = await deps.store.getDocumentByDocid(qrel.target.docid);
    if (!byDocid.ok) return byDocid;
    if (
      byDocid.value &&
      (!qrel.target.sourceHash ||
        byDocid.value.sourceHash === qrel.target.sourceHash)
    ) {
      return byDocid;
    }
  }
  if (qrel.target.uri) return deps.store.getDocumentByUri(qrel.target.uri);
  return ok(null);
};

const sourceState = (
  qrel: RetrievalQrel,
  document: DocumentRow | null
): RetrievalReplaySourceState => {
  if (!document) return "missing";
  if (!document.active) return "inactive";
  if (!document.mirrorHash) return "no_indexed_content";
  if (
    (qrel.target.sourceHash &&
      qrel.target.sourceHash !== document.sourceHash) ||
    (qrel.target.mirrorHash && qrel.target.mirrorHash !== document.mirrorHash)
  ) {
    return "stale";
  }
  return "unchanged";
};

const rankedIds = (
  qrels: RetrievalQrel[],
  ranked: Array<SearchResult | RetrievalQrelsEvidence>
): string[] =>
  ranked.map((entry) => {
    const match = qrels.find((qrel) =>
      "source" in entry
        ? targetMatchesResult(qrel, entry)
        : targetMatchesEvidence(qrel, entry)
    );
    return match?.qrelId ?? `unjudged:${"docid" in entry ? entry.docid : ""}`;
  });

const metricsFor = (qrels: RetrievalQrel[], output: string[], k: number) => {
  const expected = qrels
    .filter((qrel) => qrel.relevance > 0)
    .map((qrel) => qrel.qrelId);
  return computeRetrievalMetrics({
    output,
    expected,
    judgments: qrels.map((qrel) => ({
      docid: qrel.qrelId,
      relevance: qrel.relevance,
    })),
    k,
  });
};

const compareMetrics = (
  baseline: ReturnType<typeof metricsFor>,
  candidate: ReturnType<typeof metricsFor>
): "improved" | "unchanged" | "regressed" => {
  const left = [candidate.recallAtK, candidate.ndcgAtK, candidate.mrr];
  const right = [baseline.recallAtK, baseline.ndcgAtK, baseline.mrr];
  for (const [index, value] of left.entries()) {
    if (value > right[index]!) return "improved";
    if (value < right[index]!) return "regressed";
  }
  return "unchanged";
};

const diagnoseMissing = async (
  deps: RetrievalReplayDeps,
  source: RetrievalQrelsCase,
  qrel: RetrievalQrel
): Promise<RetrievalReplayQrelResult["diagnostic"]> => {
  const target = qrel.target.uri ?? qrel.target.docid;
  if (!target) return null;
  const targetCollection = qrel.target.uri
    ? parseUri(qrel.target.uri)?.collection
    : undefined;
  const diagnosed = await diagnoseQueryTarget(deps, source.query.text, {
    ...buildRetrievalReplaySearchOptions(
      source,
      { id: "diagnose", type: "hybrid" },
      targetCollection
    ),
    target,
  });
  if (!diagnosed.ok) return null;
  return {
    status: diagnosed.value.target.status,
    filterReasons: diagnosed.value.target.filterReasons,
    stageDropReasons: diagnosed.value.stages.flatMap((stage) =>
      stage.dropReason ? [stage.dropReason] : []
    ),
  };
};

const replayCase = async (
  deps: RetrievalReplayDeps,
  source: RetrievalQrelsCase,
  candidate: RetrievalReplayCandidate,
  currentFingerprints: Awaited<
    ReturnType<typeof buildRetrievalTraceFingerprints>
  >,
  candidateFingerprints: Awaited<
    ReturnType<typeof buildRetrievalTraceFingerprints>
  >
): Promise<RetrievalReplayCaseResult> => {
  const documents = await deps.store.listDocuments();
  const candidateResult = await runRetrievalReplayCandidate(
    deps,
    source,
    candidate
  );
  const k = retrievalReplayLimit(source, candidate);
  const baselineMetrics = metricsFor(
    source.qrels,
    rankedIds(source.qrels, source.baseline.ranked),
    k
  );
  if (!documents.ok || !candidateResult.ok) {
    return {
      caseId: source.caseId,
      traceId: source.traceId,
      terminalStatus: source.terminalStatus,
      verdict: "unreplayable",
      reason: "candidate_failed",
      metrics: {
        baseline: baselineMetrics,
        candidate: failedCandidateMetrics(),
        baselineCoverage: baselineMetrics.recallAtK,
        candidateCoverage: 0,
      },
      fingerprints: {
        original: source.fingerprints,
        current: currentFingerprints,
        candidate: candidateFingerprints,
      },
      capabilityOutcomes: {
        baseline: source.baseline.capabilityOutcomes,
        candidate: [],
      },
      fallbackCodes: {
        baseline: source.baseline.fallbackCodes,
        candidate: [],
      },
      qrels: [],
    };
  }
  const results = candidateResult.value.results;
  const candidateMetrics = metricsFor(
    source.qrels,
    rankedIds(source.qrels, results),
    k
  );
  const qrelResults: RetrievalReplayQrelResult[] = [];
  let unreplayableReason: RetrievalReplayReason | null = null;
  for (const qrel of source.qrels) {
    const document = await resolveDocument(deps, qrel, documents.value);
    const state = document.ok ? sourceState(qrel, document.value) : "missing";
    if (!qrel.baselineMissing && qrel.relevance > 0) {
      if (state === "stale") unreplayableReason = "source_stale";
      if (state === "missing") unreplayableReason = "source_missing";
    }
    const candidateIndex = results.findIndex((result) =>
      targetMatchesResult(qrel, result)
    );
    const candidateRank = candidateIndex < 0 ? null : candidateIndex + 1;
    const baselineRank = qrel.evidence?.rank ?? null;
    const hasOutcome = (kind: "opened" | "cited" | "pinned") =>
      source.baseline.outcomes[kind].some((item) =>
        targetMatchesEvidence(qrel, item)
      );
    qrelResults.push({
      qrelId: qrel.qrelId,
      label: qrel.label,
      relevance: qrel.relevance,
      baselineRank,
      plannerRank: qrel.evidence?.plannerRank ?? null,
      candidateRank,
      rankDelta:
        baselineRank === null || candidateRank === null
          ? null
          : baselineRank - candidateRank,
      opened: hasOutcome("opened"),
      cited: hasOutcome("cited"),
      pinned: hasOutcome("pinned"),
      sourceState: state,
      diagnostic:
        qrel.baselineMissing && candidateRank === null
          ? await diagnoseMissing(deps, source, qrel)
          : null,
    });
  }
  const metadata = retrievalReplayTraceMetadata(
    candidate,
    candidateResult.value
  );
  const verdict = unreplayableReason
    ? "unreplayable"
    : compareMetrics(baselineMetrics, candidateMetrics);
  return {
    caseId: source.caseId,
    traceId: source.traceId,
    terminalStatus: source.terminalStatus,
    verdict,
    reason: unreplayableReason,
    metrics: {
      baseline: baselineMetrics,
      candidate: candidateMetrics,
      baselineCoverage: baselineMetrics.recallAtK,
      candidateCoverage: candidateMetrics.recallAtK,
    },
    fingerprints: {
      original: source.fingerprints,
      current: currentFingerprints,
      candidate: candidateFingerprints,
    },
    capabilityOutcomes: {
      baseline: source.baseline.capabilityOutcomes,
      candidate:
        metadata?.capabilityOutcomes.map((outcome) => ({
          ...outcome,
          reasonCode: outcome.reasonCode ?? null,
        })) ?? [],
    },
    fallbackCodes: {
      baseline: source.baseline.fallbackCodes,
      candidate: metadata?.fallbackCodes ?? [],
    },
    qrels: qrelResults,
  };
};

export const replayRetrievalTraces = async (
  deps: RetrievalReplayDeps,
  input: ReplayRetrievalTraceInput
): Promise<StoreResult<ReplayRetrievalTraceResult>> => {
  const parsed = parseReplayRetrievalTraceInput(input);
  if (!parsed.ok) return parsed;
  const validatedInput = parsed.value;
  const stored = await deps.store.getRetrievalTraceExportBundle(
    validatedInput.exportId
  );
  if (!stored.ok) {
    if (stored.error.message.includes("missing retrieval trace")) {
      return ok(unreplayable(validatedInput, "trace_missing"));
    }
    return stored;
  }
  if (!stored.value)
    return ok(unreplayable(validatedInput, "manifest_missing"));
  if (stored.value.manifest.format !== "qrels") {
    return ok(unreplayable(validatedInput, "redaction_incompatible"));
  }
  const artifact = buildRetrievalQrelsArtifact(stored.value.traces);
  if (!artifact.ok) {
    return ok(
      unreplayable(
        validatedInput,
        reconstructionReason(artifact.error.message) ?? "trace_missing"
      )
    );
  }
  if (
    hashTraceCanonical(artifact.value) !== stored.value.manifest.artifactHash
  ) {
    return ok(unreplayable(validatedInput, "manifest_hash_mismatch"));
  }
  let currentFingerprints;
  let candidateFingerprints;
  try {
    currentFingerprints = await buildRetrievalTraceFingerprints({
      store: deps.store,
      config: deps.config,
      pipeline: "retrieval-replay-current",
      indexName: deps.indexName,
      modelUris: deps.modelUris,
    });
    candidateFingerprints = await buildRetrievalTraceFingerprints({
      store: deps.store,
      config: deps.config,
      pipeline: "retrieval-replay-candidate",
      pipelineOptions: { ...validatedInput.candidate },
      indexName: deps.indexName,
      modelUris: deps.modelUris,
    });
  } catch {
    return ok(unreplayable(validatedInput, "candidate_failed"));
  }
  const cases = [];
  for (const source of artifact.value.cases) {
    cases.push(
      await replayCase(
        deps,
        source,
        validatedInput.candidate,
        currentFingerprints,
        candidateFingerprints
      )
    );
  }
  const verdict = cases.some((item) => item.verdict === "unreplayable")
    ? "unreplayable"
    : cases.some((item) => item.verdict === "regressed")
      ? "regressed"
      : cases.some((item) => item.verdict === "improved")
        ? "improved"
        : "unchanged";
  const reason =
    cases.find((item) => item.verdict === "unreplayable")?.reason ?? null;
  return ok({
    schemaVersion: "1.0",
    exportId: validatedInput.exportId,
    candidate: validatedInput.candidate,
    verdict,
    reason,
    recommendation:
      verdict === "improved"
        ? "promote"
        : verdict === "regressed"
          ? "keep_baseline"
          : "manual_review",
    applied: false,
    cases,
  });
};
