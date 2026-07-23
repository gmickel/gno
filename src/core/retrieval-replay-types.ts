/** Public contracts for immutable retrieval replay reports. */

import type { RetrievalMetrics } from "../bench/metrics";
import type { RetrievalTraceFingerprints } from "../store/types";
import type { RetrievalQrelsCase, RetrievalQrel } from "./retrieval-qrels";

export type RetrievalReplayCandidateType = "bm25" | "vector" | "hybrid";

export interface RetrievalReplayCandidate {
  id: string;
  type: RetrievalReplayCandidateType;
  limit?: number;
  candidateLimit?: number;
  noExpand?: boolean;
  noRerank?: boolean;
  queryModes?: Array<{
    mode: "term" | "intent" | "hyde";
    text: string;
  }>;
}

export interface ReplayRetrievalTraceInput {
  exportId: string;
  candidate: RetrievalReplayCandidate;
}

export type RetrievalReplaySourceState =
  | "unchanged"
  | "stale"
  | "missing"
  | "inactive"
  | "no_indexed_content";

export type RetrievalReplayVerdict =
  | "improved"
  | "unchanged"
  | "regressed"
  | "unreplayable";

export type RetrievalReplayReason =
  | "manifest_missing"
  | "manifest_hash_mismatch"
  | "trace_missing"
  | "redaction_incompatible"
  | "query_missing"
  | "filters_incomplete"
  | "no_retrieval_run"
  | "ambiguous_missing_expected_run"
  | "source_stale"
  | "source_missing"
  | "candidate_failed";

export interface RetrievalReplayQrelResult {
  qrelId: string;
  label: RetrievalQrel["label"];
  relevance: 0 | 1;
  baselineRank: number | null;
  plannerRank: number | null;
  candidateRank: number | null;
  rankDelta: number | null;
  opened: boolean;
  cited: boolean;
  pinned: boolean;
  sourceState: RetrievalReplaySourceState;
  diagnostic: {
    status: string;
    filterReasons: string[];
    stageDropReasons: string[];
  } | null;
}

export interface RetrievalReplayCaseResult {
  caseId: string;
  traceId: string;
  terminalStatus: RetrievalQrelsCase["terminalStatus"];
  verdict: RetrievalReplayVerdict;
  reason: RetrievalReplayReason | null;
  metrics: {
    baseline: RetrievalMetrics;
    candidate: RetrievalMetrics;
    baselineCoverage: number;
    candidateCoverage: number;
  };
  fingerprints: {
    original: RetrievalTraceFingerprints;
    current: RetrievalTraceFingerprints;
    candidate: RetrievalTraceFingerprints;
  };
  capabilityOutcomes: {
    baseline: RetrievalQrelsCase["baseline"]["capabilityOutcomes"];
    candidate: RetrievalQrelsCase["baseline"]["capabilityOutcomes"];
  };
  fallbackCodes: {
    baseline: string[];
    candidate: string[];
  };
  qrels: RetrievalReplayQrelResult[];
}

export interface ReplayRetrievalTraceResult {
  schemaVersion: "1.0";
  exportId: string;
  candidate: RetrievalReplayCandidate;
  verdict: RetrievalReplayVerdict;
  reason: RetrievalReplayReason | null;
  recommendation: "promote" | "keep_baseline" | "manual_review";
  applied: false;
  cases: RetrievalReplayCaseResult[];
}
