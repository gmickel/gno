/** Canonical qrels artifacts derived only from persisted retrieval receipts. */

import type {
  RetrievalTraceBundle,
  RetrievalTraceFingerprints,
  RetrievalTraceJudgmentLabel,
  RetrievalTraceTerminalStatus,
  StoreResult,
} from "../store/types";
import type { EvidenceTarget } from "./retrieval-trace-management-helpers";

import { hashTraceCanonical } from "../store/retrieval-trace-codec";
import { err, ok } from "../store/types";
import { parseRetrievalTraceFilters } from "./retrieval-trace-filters";
import { stableTarget, targetKey } from "./retrieval-trace-management-helpers";

export interface RetrievalQrelsEvidence {
  docid: string;
  sourceHash: string;
  mirrorHash: string;
  uri: string;
  seq: number | null;
  startLine: number;
  endLine: number;
  passageHash: string;
  rank: number | null;
  plannerRank: number | null;
  score: number | null;
  sources: string[];
  graphExpanded: boolean;
}

export interface RetrievalQrel {
  qrelId: string;
  judgmentId: string;
  label: RetrievalTraceJudgmentLabel;
  relevance: 0 | 1;
  baselineMissing: boolean;
  target: EvidenceTarget;
  evidence: RetrievalQrelsEvidence | null;
}

export interface RetrievalQrelsCase {
  caseId: string;
  traceId: string;
  retrievalRunId: string;
  terminalStatus: RetrievalTraceTerminalStatus;
  query: {
    text: string;
    digest: string;
    goalText: string | null;
    goalDigest: string | null;
    filters: Record<string, unknown>;
  };
  fingerprints: RetrievalTraceFingerprints;
  baseline: {
    ranked: RetrievalQrelsEvidence[];
    capabilities: string[];
    capabilityOutcomes: Array<{
      capability: string;
      status: "attempted" | "used" | "unavailable" | "failed";
      reasonCode: string | null;
    }>;
    fallbackCodes: string[];
    outcomes: {
      opened: RetrievalQrelsEvidence[];
      cited: RetrievalQrelsEvidence[];
      pinned: RetrievalQrelsEvidence[];
    };
  };
  judgments: {
    history: Array<{
      judgmentId: string;
      label: RetrievalTraceJudgmentLabel;
      targetKind: string;
      target: EvidenceTarget;
      createdAtMs: number;
      canonicalDigest: string;
    }>;
    effective: string[];
  };
  qrels: RetrievalQrel[];
}

export interface RetrievalTraceQrelsArtifact {
  schemaVersion: "1.0";
  format: "qrels";
  cases: RetrievalQrelsCase[];
}

const exactEvidence = (value: unknown): RetrievalQrelsEvidence | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (
    typeof item.docid !== "string" ||
    typeof item.sourceHash !== "string" ||
    typeof item.mirrorHash !== "string" ||
    typeof item.uri !== "string" ||
    !item.uri.startsWith("gno://") ||
    typeof item.startLine !== "number" ||
    typeof item.endLine !== "number" ||
    typeof item.passageHash !== "string"
  ) {
    return null;
  }
  return {
    docid: item.docid,
    sourceHash: item.sourceHash,
    mirrorHash: item.mirrorHash,
    uri: item.uri,
    seq: typeof item.seq === "number" ? item.seq : null,
    startLine: item.startLine,
    endLine: item.endLine,
    passageHash: item.passageHash,
    rank: typeof item.rank === "number" ? item.rank : null,
    plannerRank: typeof item.plannerRank === "number" ? item.plannerRank : null,
    score: typeof item.score === "number" ? item.score : null,
    sources: Array.isArray(item.sources)
      ? item.sources
          .filter((entry): entry is string => typeof entry === "string")
          .sort()
      : [],
    graphExpanded: item.graphExpanded === true,
  };
};

const evidenceArray = (
  payload: Record<string, unknown>,
  key: "ranked" | "evidence"
): RetrievalQrelsEvidence[] =>
  Array.isArray(payload[key])
    ? payload[key].flatMap((value) => {
        const parsed = exactEvidence(value);
        return parsed ? [parsed] : [];
      })
    : [];

const sameDocument = (
  target: EvidenceTarget,
  evidence: RetrievalQrelsEvidence
): boolean =>
  (target.sourceHash !== undefined &&
    target.sourceHash === evidence.sourceHash) ||
  (target.docid !== undefined && target.docid === evidence.docid) ||
  (target.uri !== undefined && target.uri === evidence.uri);

const evidenceMatches = (
  target: EvidenceTarget,
  evidence: RetrievalQrelsEvidence
): boolean =>
  sameDocument(target, evidence) &&
  (target.seq === undefined || target.seq === evidence.seq) &&
  (target.startLine === undefined || target.startLine === evidence.startLine) &&
  (target.endLine === undefined || target.endLine === evidence.endLine) &&
  (target.passageHash === undefined ||
    target.passageHash === evidence.passageHash);

const effectiveJudgments = (
  judgments: RetrievalTraceBundle["judgments"]
): RetrievalTraceBundle["judgments"] => {
  const latest = new Map<string, RetrievalTraceBundle["judgments"][number]>();
  for (const judgment of judgments) {
    const target = stableTarget(judgment.target);
    if (!target) continue;
    if (judgment.targetKind === "query") continue;
    const key = targetKey(judgment.targetKind, target);
    const previous = latest.get(key);
    if (
      !previous ||
      judgment.createdAtMs > previous.createdAtMs ||
      (judgment.createdAtMs === previous.createdAtMs &&
        judgment.judgmentId > previous.judgmentId)
    ) {
      latest.set(key, judgment);
    }
  }
  return [...latest.values()].sort((left, right) =>
    left.judgmentId.localeCompare(right.judgmentId)
  );
};

const capabilityOutcomes = (
  trace: RetrievalTraceBundle,
  runId: string
): RetrievalQrelsCase["baseline"]["capabilityOutcomes"] =>
  trace.events
    .filter((event) => event.kind === "capability" && event.runId === runId)
    .flatMap((event) => {
      const { capability, status, reasonCode } = event.payload;
      if (
        typeof capability !== "string" ||
        !["attempted", "used", "unavailable", "failed"].includes(String(status))
      ) {
        return [];
      }
      return [
        {
          capability,
          status: status as "attempted" | "used" | "unavailable" | "failed",
          reasonCode: typeof reasonCode === "string" ? reasonCode : null,
        },
      ];
    })
    .sort((left, right) =>
      `${left.capability}\0${left.status}\0${left.reasonCode ?? ""}`.localeCompare(
        `${right.capability}\0${right.status}\0${right.reasonCode ?? ""}`
      )
    );

const outcomeEvidence = (
  trace: RetrievalTraceBundle,
  kind: "open" | "cite" | "pin",
  runId: string
): RetrievalQrelsEvidence[] =>
  trace.events
    .filter((event) => event.kind === kind && event.runId === runId)
    .flatMap((event) => evidenceArray(event.payload, "evidence"));

const assignedRun = (
  judgment: RetrievalTraceBundle["judgments"][number],
  retrievalRuns: RetrievalTraceBundle["runs"]
): StoreResult<string> => {
  if (retrievalRuns.some((run) => run.runId === judgment.runId)) {
    return ok(judgment.runId!);
  }
  if (
    judgment.runId === null &&
    judgment.label === "missing_expected" &&
    retrievalRuns.length === 1
  ) {
    return ok(retrievalRuns[0]!.runId);
  }
  return err(
    "CONSTRAINT_VIOLATION",
    "ambiguous_missing_expected_run: judgment cannot be assigned to one retrieval run"
  );
};

const sortedStringSet = (value: unknown): string[] =>
  Array.isArray(value)
    ? [
        ...new Set(
          value.filter((item): item is string => typeof item === "string")
        ),
      ].sort()
    : [];

export const buildRetrievalQrelsArtifact = (
  bundles: RetrievalTraceBundle[]
): StoreResult<RetrievalTraceQrelsArtifact> => {
  const cases: RetrievalQrelsCase[] = [];
  for (const trace of [...bundles].sort((a, b) =>
    a.trace.traceId.localeCompare(b.trace.traceId)
  )) {
    const header = trace.trace;
    if (
      header.status === "open" ||
      header.redactionMode !== "replay" ||
      !header.replayCapable
    ) {
      return err(
        "CONSTRAINT_VIOLATION",
        `redaction_incompatible: ${header.traceId} is not a terminal replay receipt`
      );
    }
    if (!header.queryText || !header.queryDigest) {
      return err(
        "CONSTRAINT_VIOLATION",
        `query_missing: ${header.traceId} lacks replay query text or digest`
      );
    }
    const filters = parseRetrievalTraceFilters(header.filters);
    if (!filters.ok) return filters;
    const retrievalRuns = trace.runs.filter((run) => run.kind === "retrieval");
    if (retrievalRuns.length === 0) {
      return err("CONSTRAINT_VIOLATION", `no_retrieval_run: ${header.traceId}`);
    }
    const rankedByRun = new Map(
      retrievalRuns.map((run) => [
        run.runId,
        evidenceArray(run.payload, "ranked"),
      ])
    );
    const historyByRun = new Map<string, RetrievalTraceBundle["judgments"]>();
    for (const judgment of trace.judgments) {
      const assignment = assignedRun(judgment, retrievalRuns);
      if (!assignment.ok) return assignment;
      const current = historyByRun.get(assignment.value) ?? [];
      current.push(judgment);
      historyByRun.set(assignment.value, current);
    }
    const effectiveByRun = new Map<string, RetrievalTraceBundle["judgments"]>();
    for (const run of retrievalRuns) {
      effectiveByRun.set(
        run.runId,
        effectiveJudgments(historyByRun.get(run.runId) ?? [])
      );
    }
    if (
      ![...effectiveByRun.values()]
        .flat()
        .some(
          ({ label }) => label === "relevant" || label === "missing_expected"
        )
    ) {
      return err(
        "CONSTRAINT_VIOLATION",
        `qrels export requires relevant or missing_expected judgments: ${header.traceId}`
      );
    }
    for (const run of retrievalRuns) {
      const runJudgments = effectiveByRun.get(run.runId) ?? [];
      if (runJudgments.length === 0) continue;
      const runOutcomes = {
        opened: outcomeEvidence(trace, "open", run.runId),
        cited: outcomeEvidence(trace, "cite", run.runId),
        pinned: outcomeEvidence(trace, "pin", run.runId),
      };
      const allExact = [
        ...(rankedByRun.get(run.runId) ?? []),
        ...runOutcomes.opened,
        ...runOutcomes.cited,
        ...runOutcomes.pinned,
      ];
      const qrels: RetrievalQrel[] = [];
      for (const judgment of runJudgments) {
        const target = stableTarget(judgment.target);
        if (!target) {
          return err("CONSTRAINT_VIOLATION", "Judgment target is incomplete");
        }
        const evidence =
          judgment.label === "missing_expected"
            ? null
            : (allExact.find((item) => evidenceMatches(target, item)) ?? null);
        if (judgment.label !== "missing_expected" && !evidence) {
          return err(
            "CONSTRAINT_VIOLATION",
            `Judgment ${judgment.judgmentId} lacks exact evidence provenance`
          );
        }
        qrels.push({
          qrelId: `qrel-${hashTraceCanonical({
            judgmentId: judgment.judgmentId,
            label: judgment.label,
            target,
          }).slice(0, 40)}`,
          judgmentId: judgment.judgmentId,
          label: judgment.label,
          relevance: judgment.label === "irrelevant" ? 0 : 1,
          baselineMissing: judgment.label === "missing_expected",
          target,
          evidence,
        });
      }
      cases.push({
        caseId: `trace-case-${hashTraceCanonical({
          traceId: header.traceId,
          runId: run.runId,
        }).slice(0, 40)}`,
        traceId: header.traceId,
        retrievalRunId: run.runId,
        terminalStatus: header.status,
        query: {
          text: header.queryText,
          digest: header.queryDigest,
          goalText: header.goalText,
          goalDigest: header.goalDigest,
          filters: filters.value,
        },
        fingerprints: header.fingerprints,
        baseline: {
          ranked: rankedByRun.get(run.runId) ?? [],
          capabilities: sortedStringSet(run.payload.capabilities),
          capabilityOutcomes: capabilityOutcomes(trace, run.runId),
          fallbackCodes: sortedStringSet(run.payload.fallbackCodes),
          outcomes: runOutcomes,
        },
        judgments: {
          history: (historyByRun.get(run.runId) ?? []).flatMap((judgment) => {
            const target = stableTarget(judgment.target);
            return target
              ? [
                  {
                    judgmentId: judgment.judgmentId,
                    label: judgment.label,
                    targetKind: judgment.targetKind,
                    target,
                    createdAtMs: judgment.createdAtMs,
                    canonicalDigest: judgment.canonicalDigest,
                  },
                ]
              : [];
          }),
          effective: runJudgments.map((judgment) => judgment.judgmentId),
        },
        qrels: qrels.sort((a, b) => a.qrelId.localeCompare(b.qrelId)),
      });
    }
  }
  return ok({
    schemaVersion: "1.0",
    format: "qrels",
    cases: cases.sort((a, b) => a.caseId.localeCompare(b.caseId)),
  });
};
