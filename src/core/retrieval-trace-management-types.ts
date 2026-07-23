import type {
  RetrievalTraceAppendResult,
  RetrievalTraceBundle,
  RetrievalTraceDeleteCounts,
  RetrievalTraceExportFormat,
  RetrievalTraceExportManifestRow,
  RetrievalTraceJudgmentLabel,
  RetrievalTraceJudgmentRow,
  RetrievalTraceJudgmentTargetKind,
  RetrievalTracePurgeResult as StoredRetrievalTracePurgeResult,
  RetrievalTraceRow,
} from "../store/types";
import type { RetrievalTraceQrelsArtifact } from "./retrieval-qrels";

export interface RetrievalTraceSummary {
  traceId: string;
  schemaVersion: "1.0";
  redactionMode: RetrievalTraceRow["redactionMode"];
  replayCapable: boolean;
  status: RetrievalTraceRow["status"];
  queryShape: RetrievalTraceRow["queryShape"];
  goalShape: RetrievalTraceRow["goalShape"];
  fingerprints: RetrievalTraceRow["fingerprints"];
  createdAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number;
  byteSize: number;
  creationDigest: string;
}

export interface RetrievalTraceListOptions {
  limit?: number;
  cursor?: string;
}

export interface RetrievalTraceListResult {
  schemaVersion: "1.0";
  traces: RetrievalTraceSummary[];
  nextCursor: string | null;
}

export interface RetrievalTraceDetailOptions {
  detailLimit?: number;
}

export interface RetrievalTraceDetail extends Omit<
  RetrievalTraceBundle,
  "runs" | "events" | "judgments" | "exports"
> {
  schemaVersion: "1.0";
  runs: RetrievalTraceBundle["runs"];
  events: RetrievalTraceBundle["events"];
  judgments: RetrievalTraceBundle["judgments"];
  exports: RetrievalTraceBundle["exports"];
  totals: {
    runs: number;
    events: number;
    judgments: number;
    exports: number;
  };
  truncated: {
    runs: boolean;
    events: boolean;
    judgments: boolean;
    exports: boolean;
  };
}

export interface LabelRetrievalTraceInput {
  traceId: string;
  label: RetrievalTraceJudgmentLabel;
  targetRef: string;
  targetKind?: Exclude<RetrievalTraceJudgmentTargetKind, "query">;
  startLine?: number;
  endLine?: number;
  sourceHash?: string;
  docid?: string;
  idempotencyKey?: string;
}

export interface LabelRetrievalTraceResult {
  schemaVersion: "1.0";
  result: RetrievalTraceAppendResult;
  judgment: RetrievalTraceJudgmentRow;
}

export interface RetrievalTraceAgenticArtifact {
  schemaVersion: "1.0";
  format: "agentic-receipt";
  traces: Array<Omit<RetrievalTraceBundle, "exports">>;
}

export type RetrievalTraceArtifact =
  | RetrievalTraceAgenticArtifact
  | RetrievalTraceQrelsArtifact;

export interface ExportRetrievalTracesInput<
  Format extends RetrievalTraceExportFormat = "agentic-receipt",
> {
  traceIds: string[];
  format?: Format;
}

export interface ExportRetrievalTracesResult<
  Format extends RetrievalTraceExportFormat = "agentic-receipt",
> {
  schemaVersion: "1.0";
  result: RetrievalTraceAppendResult;
  manifest: RetrievalTraceExportManifestRow;
  artifact: Format extends "qrels"
    ? RetrievalTraceQrelsArtifact
    : RetrievalTraceAgenticArtifact;
}

export interface DeleteRetrievalTraceResult {
  schemaVersion: "1.0";
  traceId: string;
  deleted: boolean;
  counts: RetrievalTraceDeleteCounts;
}

export interface PurgeRetrievalTracesResult extends StoredRetrievalTracePurgeResult {
  schemaVersion: "1.0";
}

export type RetrievalTraceListRequest = RetrievalTraceListOptions;
export type RetrievalTraceLabelRequest = LabelRetrievalTraceInput;
export type RetrievalTraceExportRequest = ExportRetrievalTracesInput;
export type RetrievalTraceLabelResult = LabelRetrievalTraceResult;
export type RetrievalTraceExportResult = ExportRetrievalTracesResult;
export type RetrievalTraceDeleteResult = DeleteRetrievalTraceResult;
export type RetrievalTracePurgeResult = PurgeRetrievalTracesResult;
