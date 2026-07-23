/** SQLite row codecs and shared validation for retrieval trace storage. */

import type { Database } from "bun:sqlite";

import type {
  RetrievalTraceDeleteCounts,
  RetrievalTraceEventInput,
  RetrievalTraceEventRow,
  RetrievalTraceExportInput,
  RetrievalTraceExportRow,
  RetrievalTraceJudgmentInput,
  RetrievalTraceJudgmentRow,
  RetrievalTraceRow,
  RetrievalTraceRunInput,
  RetrievalTraceRunRow,
  StoreResult,
} from "../types";

import { traceJsonObjectSchema } from "../retrieval-trace-codec";
import { err } from "../types";

export interface DbRetrievalTraceRow {
  trace_id: string;
  schema_version: "1.0";
  redaction_mode: "metadata" | "replay";
  replay_capable: number;
  query_text: string | null;
  query_digest: string | null;
  query_shape_json: string;
  goal_text: string | null;
  goal_digest: string | null;
  goal_shape_json: string;
  filters_json: string;
  pipeline_fingerprint: string;
  model_fingerprint: string;
  config_fingerprint: string;
  index_fingerprint: string;
  status: RetrievalTraceRow["status"];
  created_at_ms: number;
  updated_at_ms: number;
  expires_at_ms: number;
  byte_size: number;
  creation_digest: string;
}

export interface DbRetrievalTraceRunRow {
  run_id: string;
  trace_id: string;
  idempotency_key: string;
  kind: RetrievalTraceRunInput["kind"];
  payload_json: string;
  payload_bytes: number;
  canonical_digest: string;
  created_at_ms: number;
}

export interface DbRetrievalTraceEventRow {
  event_id: string;
  trace_id: string;
  run_id: string | null;
  idempotency_key: string;
  kind: RetrievalTraceEventInput["kind"];
  payload_json: string;
  payload_bytes: number;
  canonical_digest: string;
  created_at_ms: number;
}

export interface DbRetrievalTraceJudgmentRow {
  judgment_id: string;
  trace_id: string;
  run_id: string | null;
  idempotency_key: string;
  label: RetrievalTraceJudgmentInput["label"];
  target_kind: RetrievalTraceJudgmentInput["targetKind"];
  target_ref: string;
  target_json: string;
  target_bytes: number;
  canonical_digest: string;
  created_at_ms: number;
}

export interface DbRetrievalTraceExportRow {
  export_id: string;
  trace_id: string;
  format: RetrievalTraceExportInput["format"];
  artifact_hash: string;
  created_at_ms: number;
}

const parseJsonObject = (raw: string): Record<string, unknown> =>
  traceJsonObjectSchema.parse(JSON.parse(raw));

export const mapTraceRow = (row: DbRetrievalTraceRow): RetrievalTraceRow => ({
  traceId: row.trace_id,
  schemaVersion: row.schema_version,
  redactionMode: row.redaction_mode,
  replayCapable: row.replay_capable === 1,
  queryText: row.query_text,
  queryDigest: row.query_digest,
  queryShape: JSON.parse(
    row.query_shape_json
  ) as RetrievalTraceRow["queryShape"],
  goalText: row.goal_text,
  goalDigest: row.goal_digest,
  goalShape: JSON.parse(row.goal_shape_json) as RetrievalTraceRow["goalShape"],
  filters: parseJsonObject(row.filters_json),
  fingerprints: {
    pipeline: row.pipeline_fingerprint,
    model: row.model_fingerprint,
    config: row.config_fingerprint,
    index: row.index_fingerprint,
  },
  status: row.status,
  createdAtMs: row.created_at_ms,
  updatedAtMs: row.updated_at_ms,
  expiresAtMs: row.expires_at_ms,
  byteSize: row.byte_size,
  creationDigest: row.creation_digest,
});

export const mapRunRow = (
  row: DbRetrievalTraceRunRow
): RetrievalTraceRunRow => ({
  runId: row.run_id,
  traceId: row.trace_id,
  idempotencyKey: row.idempotency_key,
  kind: row.kind,
  payload: parseJsonObject(row.payload_json),
  payloadBytes: row.payload_bytes,
  canonicalDigest: row.canonical_digest,
  createdAtMs: row.created_at_ms,
});

export const mapEventRow = (
  row: DbRetrievalTraceEventRow
): RetrievalTraceEventRow => ({
  eventId: row.event_id,
  traceId: row.trace_id,
  runId: row.run_id,
  idempotencyKey: row.idempotency_key,
  kind: row.kind,
  payload: parseJsonObject(row.payload_json),
  payloadBytes: row.payload_bytes,
  canonicalDigest: row.canonical_digest,
  createdAtMs: row.created_at_ms,
});

export const mapJudgmentRow = (
  row: DbRetrievalTraceJudgmentRow
): RetrievalTraceJudgmentRow => ({
  judgmentId: row.judgment_id,
  traceId: row.trace_id,
  runId: row.run_id,
  idempotencyKey: row.idempotency_key,
  label: row.label,
  targetKind: row.target_kind,
  targetRef: row.target_ref,
  target: parseJsonObject(row.target_json),
  targetBytes: row.target_bytes,
  canonicalDigest: row.canonical_digest,
  createdAtMs: row.created_at_ms,
});

export const mapExportRow = (
  row: DbRetrievalTraceExportRow
): RetrievalTraceExportRow => ({
  exportId: row.export_id,
  traceId: row.trace_id,
  format: row.format,
  artifactHash: row.artifact_hash,
  createdAtMs: row.created_at_ms,
});

export class RetrievalTraceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetrievalTraceConflictError";
  }
}

export const validateTraceId = (value: string, label: string): void => {
  if (value.length < 1 || value.length > 128) {
    throw new RangeError(`${label} must be from 1 to 128 characters`);
  }
};

export const traceWriteError = <T>(
  cause: unknown,
  fallback: string
): StoreResult<T> => {
  const message = cause instanceof Error ? cause.message : fallback;
  if (
    cause instanceof RetrievalTraceConflictError ||
    message.includes("constraint failed") ||
    message.includes("FOREIGN KEY constraint") ||
    message.includes("retrieval trace record cap exceeded")
  ) {
    return err("CONSTRAINT_VIOLATION", message, cause);
  }
  if (
    cause instanceof RangeError ||
    (cause instanceof Error && cause.name === "ZodError")
  ) {
    return err("INVALID_INPUT", message, cause);
  }
  return err("QUERY_FAILED", message, cause);
};

export const traceReadError = <T>(
  cause: unknown,
  fallback: string
): StoreResult<T> =>
  cause instanceof RangeError
    ? err("INVALID_INPUT", cause.message, cause)
    : err(
        "QUERY_FAILED",
        cause instanceof Error ? cause.message : fallback,
        cause
      );

const countRows = (db: Database, table: string, traceId?: string): number => {
  if (traceId === undefined) {
    return (
      db
        .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`)
        .get()?.count ?? 0
    );
  }
  return (
    db
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) AS count FROM ${table} WHERE trace_id = ?`
      )
      .get(traceId)?.count ?? 0
  );
};

export const countTraceContent = (
  db: Database,
  traceId?: string
): RetrievalTraceDeleteCounts => {
  const exportCount =
    traceId === undefined
      ? countRows(db, "retrieval_trace_exports")
      : (db
          .query<{ count: number }, [string, string]>(
            `SELECT COUNT(*) AS count FROM retrieval_trace_exports x
             WHERE EXISTS (
               SELECT 1 FROM retrieval_trace_export_traces own
               WHERE own.export_id = x.export_id AND own.trace_id = ?
             )
             AND NOT EXISTS (
               SELECT 1 FROM retrieval_trace_export_traces other
               WHERE other.export_id = x.export_id AND other.trace_id != ?
             )`
          )
          .get(traceId, traceId)?.count ?? 0);
  return {
    traces: countRows(db, "retrieval_traces", traceId),
    runs: countRows(db, "retrieval_trace_runs", traceId),
    events: countRows(db, "retrieval_trace_events", traceId),
    judgments: countRows(db, "retrieval_trace_judgments", traceId),
    exports: exportCount,
    exportLinks: countRows(db, "retrieval_trace_export_traces", traceId),
  };
};
