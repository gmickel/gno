/** Exact retrieval-run provenance for later evidence outcomes. */

import type { StoreResult } from "../store/types";

import { err, ok } from "../store/types";

export interface RetrievalTraceEvidence {
  docid: string;
  sourceHash: string;
  mirrorHash: string;
  uri: string;
  seq?: number;
  startLine: number;
  endLine: number;
  passageHash: string;
  score?: number;
  rank?: number;
  plannerRank?: number;
  sources?: string[];
  graphExpanded?: boolean;
}

const documentIdentity = (evidence: RetrievalTraceEvidence): string =>
  [evidence.docid, evidence.sourceHash, evidence.mirrorHash, evidence.uri].join(
    "\0"
  );

const passageIdentity = (evidence: RetrievalTraceEvidence): string =>
  [
    documentIdentity(evidence),
    evidence.startLine,
    evidence.endLine,
    evidence.passageHash,
  ].join("\0");

const addRun = (
  index: Map<string, Set<string>>,
  key: string,
  runId: string
): void => {
  const runs = index.get(key) ?? new Set<string>();
  runs.add(runId);
  index.set(key, runs);
};

const storedEvidence = (value: unknown): RetrievalTraceEvidence | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (
    typeof item.docid !== "string" ||
    typeof item.sourceHash !== "string" ||
    typeof item.mirrorHash !== "string" ||
    typeof item.uri !== "string" ||
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
    startLine: item.startLine,
    endLine: item.endLine,
    passageHash: item.passageHash,
    ...(typeof item.seq === "number" ? { seq: item.seq } : {}),
  };
};

export class RetrievalTraceEvidenceOrigins {
  private readonly documents = new Map<string, Set<string>>();
  private readonly passages = new Map<string, Set<string>>();

  add(runId: string, evidence: RetrievalTraceEvidence[]): void {
    for (const item of evidence) {
      addRun(this.documents, documentIdentity(item), runId);
      addRun(this.passages, passageIdentity(item), runId);
    }
  }

  addFallback(runId: string, evidence: RetrievalTraceEvidence[]): void {
    for (const item of evidence) {
      const passageRuns = this.passages.get(passageIdentity(item));
      const documentRuns = this.documents.get(documentIdentity(item));
      if (
        (passageRuns && passageRuns.size > 0) ||
        (documentRuns && documentRuns.size > 0)
      ) {
        continue;
      }
      addRun(this.documents, documentIdentity(item), runId);
      addRun(this.passages, passageIdentity(item), runId);
    }
  }

  addStored(runId: string, payload: Record<string, unknown>): void {
    const ranked = Array.isArray(payload.ranked) ? payload.ranked : [];
    this.add(
      runId,
      ranked.flatMap((value) => {
        const parsed = storedEvidence(value);
        return parsed ? [parsed] : [];
      })
    );
  }

  addStoredFallback(runId: string, payload: Record<string, unknown>): void {
    const evidence = Array.isArray(payload.evidence) ? payload.evidence : [];
    this.addFallback(
      runId,
      evidence.flatMap((value) => {
        const parsed = storedEvidence(value);
        return parsed ? [parsed] : [];
      })
    );
  }

  addStoredRuns(
    runs: Array<{
      runId: string;
      kind: string;
      payload: Record<string, unknown>;
    }>
  ): void {
    for (const run of runs.filter(({ kind }) => kind === "retrieval")) {
      this.addStored(run.runId, run.payload);
    }
    for (const run of runs.filter(({ kind }) => kind === "get")) {
      this.addStoredFallback(run.runId, run.payload);
    }
  }

  group(
    evidence: RetrievalTraceEvidence[]
  ): StoreResult<Map<string, RetrievalTraceEvidence[]>> {
    if (evidence.length === 0) {
      return err(
        "INVALID_INPUT",
        "outcome_evidence_unmatched: evidence outcomes cannot be empty"
      );
    }
    const groups = new Map<string, RetrievalTraceEvidence[]>();
    for (const item of evidence) {
      const passageRuns = this.passages.get(passageIdentity(item));
      const documentRuns = this.documents.get(documentIdentity(item));
      const candidates =
        passageRuns && passageRuns.size > 0 ? passageRuns : documentRuns;
      if (!candidates || candidates.size === 0) {
        return err(
          "INVALID_INPUT",
          `outcome_evidence_unmatched: ${item.uri} was not produced by a retrieval run`
        );
      }
      if (candidates.size !== 1) {
        return err(
          "INVALID_INPUT",
          `outcome_evidence_ambiguous: ${item.uri} belongs to multiple retrieval runs`
        );
      }
      const runId = candidates.values().next().value;
      if (typeof runId !== "string") {
        return err(
          "INVALID_INPUT",
          `outcome_evidence_unmatched: ${item.uri} has no retrieval run`
        );
      }
      const current = groups.get(runId) ?? [];
      current.push(item);
      groups.set(runId, current);
    }
    return ok(groups);
  }
}
