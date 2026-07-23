/** SQLite CRUD for versioned private retrieval trace receipts. */

import type { Database } from "bun:sqlite";

import type {
  RetrievalTraceAppendResult,
  RetrievalTraceBundle,
  RetrievalTraceCursor,
  RetrievalTraceEventInput,
  RetrievalTraceExportInput,
  RetrievalTraceInput,
  RetrievalTraceJudgmentInput,
  RetrievalTraceRow,
  RetrievalTraceRunInput,
  RetrievalTraceTerminalStatus,
  StoreResult,
} from "../types";

import {
  canonicalTraceJson,
  hashRetrievalTraceCreation,
  hashTraceCanonical,
  parseRetrievalTraceEventInput,
  parseRetrievalTraceExportInput,
  parseRetrievalTraceInput,
  parseRetrievalTraceJudgmentInput,
  parseRetrievalTraceRunInput,
  traceUtf8Bytes,
} from "../retrieval-trace-codec";
import { err, ok } from "../types";
import {
  type DbRetrievalTraceEventRow,
  type DbRetrievalTraceExportRow,
  type DbRetrievalTraceJudgmentRow,
  type DbRetrievalTraceRow,
  type DbRetrievalTraceRunRow,
  mapEventRow,
  mapExportRow,
  mapJudgmentRow,
  mapRunRow,
  mapTraceRow,
  RetrievalTraceConflictError,
  traceReadError,
  traceWriteError,
  validateTraceId,
} from "./retrieval-trace-rows";

type IdempotentTable =
  | "retrieval_trace_runs"
  | "retrieval_trace_events"
  | "retrieval_trace_judgments";
type IdColumn = "run_id" | "event_id" | "judgment_id";

const existingDigest = (
  db: Database,
  table: IdempotentTable,
  idColumn: IdColumn,
  id: string,
  traceId: string,
  idempotencyKey: string
): string | null =>
  db
    .query<{ canonical_digest: string }, [string, string, string]>(
      `SELECT canonical_digest FROM ${table}
       WHERE ${idColumn} = ? OR (trace_id = ? AND idempotency_key = ?)
       LIMIT 1`
    )
    .get(id, traceId, idempotencyKey)?.canonical_digest ?? null;

const settleIdempotentInsert = (
  db: Database,
  table: IdempotentTable,
  idColumn: IdColumn,
  id: string,
  traceId: string,
  idempotencyKey: string,
  digest: string,
  changes: number
): RetrievalTraceAppendResult => {
  if (changes > 0) return "inserted";
  const stored = existingDigest(
    db,
    table,
    idColumn,
    id,
    traceId,
    idempotencyKey
  );
  if (stored === digest) return "duplicate";
  throw new RetrievalTraceConflictError(
    `${table} idempotency key already exists with different content`
  );
};

const enforceByteLimit = (
  value: string,
  maxBytes: number,
  label: string
): number => {
  const bytes = traceUtf8Bytes(value);
  if (bytes > maxBytes) {
    throw new RangeError(`${label} exceeds ${maxBytes} UTF-8 bytes`);
  }
  return bytes;
};

export const createTrace = (
  db: Database,
  input: RetrievalTraceInput
): StoreResult<RetrievalTraceAppendResult> => {
  try {
    const trace = parseRetrievalTraceInput(input);
    const queryShapeJson = canonicalTraceJson(trace.queryShape);
    const goalShapeJson = canonicalTraceJson(trace.goalShape);
    const filtersJson = canonicalTraceJson(trace.filters);
    const queryBytes = enforceByteLimit(
      trace.queryText ?? "",
      8192,
      "Retrieval trace query"
    );
    const shapeBytes = enforceByteLimit(
      queryShapeJson,
      1024,
      "Retrieval trace query shape"
    );
    const goalBytes = enforceByteLimit(
      trace.goalText ?? "",
      8192,
      "Retrieval trace goal"
    );
    const goalShapeBytes = enforceByteLimit(
      goalShapeJson,
      1024,
      "Retrieval trace goal shape"
    );
    const filterBytes = enforceByteLimit(
      filtersJson,
      16_384,
      "Retrieval trace filters"
    );
    const creationDigest = hashRetrievalTraceCreation(trace);
    const insert = db.run(
      `INSERT OR IGNORE INTO retrieval_traces (
         trace_id, schema_version, redaction_mode, replay_capable,
         query_text, query_digest, query_shape_json,
         goal_text, goal_digest, goal_shape_json, filters_json,
         pipeline_fingerprint, model_fingerprint, config_fingerprint,
         index_fingerprint, status, created_at_ms, updated_at_ms,
         expires_at_ms, byte_size, creation_digest
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        trace.traceId,
        trace.schemaVersion,
        trace.redactionMode,
        trace.replayCapable ? 1 : 0,
        trace.queryText,
        trace.queryDigest,
        queryShapeJson,
        trace.goalText,
        trace.goalDigest,
        goalShapeJson,
        filtersJson,
        trace.fingerprints.pipeline,
        trace.fingerprints.model,
        trace.fingerprints.config,
        trace.fingerprints.index,
        trace.status,
        trace.createdAtMs,
        trace.updatedAtMs,
        trace.expiresAtMs,
        queryBytes + shapeBytes + goalBytes + goalShapeBytes + filterBytes,
        creationDigest,
      ]
    );
    if (insert.changes > 0) return ok("inserted");
    const stored = db
      .query<{ creation_digest: string }, [string]>(
        "SELECT creation_digest FROM retrieval_traces WHERE trace_id = ?"
      )
      .get(trace.traceId);
    if (stored?.creation_digest === creationDigest) return ok("duplicate");
    return err(
      "CONSTRAINT_VIOLATION",
      `trace_id ${trace.traceId} already exists with different content`
    );
  } catch (cause) {
    return traceWriteError(cause, "Failed to create retrieval trace");
  }
};

export const getTrace = (
  db: Database,
  traceId: string
): StoreResult<RetrievalTraceBundle | null> => {
  try {
    validateTraceId(traceId, "traceId");
    const trace = db
      .query<DbRetrievalTraceRow, [string]>(
        "SELECT * FROM retrieval_traces WHERE trace_id = ?"
      )
      .get(traceId);
    if (!trace) return ok(null);
    const runs = db
      .query<DbRetrievalTraceRunRow, [string]>(
        `SELECT * FROM retrieval_trace_runs WHERE trace_id = ?
         ORDER BY created_at_ms, run_id`
      )
      .all(traceId);
    const events = db
      .query<DbRetrievalTraceEventRow, [string]>(
        `SELECT * FROM retrieval_trace_events WHERE trace_id = ?
         ORDER BY created_at_ms, event_id`
      )
      .all(traceId);
    const judgments = db
      .query<DbRetrievalTraceJudgmentRow, [string]>(
        `SELECT * FROM retrieval_trace_judgments WHERE trace_id = ?
         ORDER BY created_at_ms, judgment_id`
      )
      .all(traceId);
    const exports = db
      .query<DbRetrievalTraceExportRow, [string]>(
        `SELECT x.*, et.trace_id FROM retrieval_trace_exports x
         JOIN retrieval_trace_export_traces et USING (export_id)
         WHERE et.trace_id = ? ORDER BY x.created_at_ms, x.export_id`
      )
      .all(traceId);
    return ok({
      trace: mapTraceRow(trace),
      runs: runs.map(mapRunRow),
      events: events.map(mapEventRow),
      judgments: judgments.map(mapJudgmentRow),
      exports: exports.map(mapExportRow),
    });
  } catch (cause) {
    return traceReadError(cause, "Failed to get retrieval trace");
  }
};

export const listTraces = (
  db: Database,
  limit: number,
  cursor?: RetrievalTraceCursor
): StoreResult<RetrievalTraceRow[]> => {
  try {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      return err("INVALID_INPUT", "Trace limit must be from 1 to 10000");
    }
    if (cursor) {
      validateTraceId(cursor.traceId, "cursor.traceId");
      if (!Number.isSafeInteger(cursor.createdAtMs) || cursor.createdAtMs < 0) {
        return err(
          "INVALID_INPUT",
          "Trace cursor time must be epoch milliseconds"
        );
      }
      return ok(
        db
          .query<DbRetrievalTraceRow, [number, number, string, number]>(
            `SELECT * FROM retrieval_traces
             WHERE created_at_ms < ?
                OR (created_at_ms = ? AND trace_id > ?)
             ORDER BY created_at_ms DESC, trace_id ASC LIMIT ?`
          )
          .all(cursor.createdAtMs, cursor.createdAtMs, cursor.traceId, limit)
          .map(mapTraceRow)
      );
    }
    return ok(
      db
        .query<DbRetrievalTraceRow, [number]>(
          `SELECT * FROM retrieval_traces
           ORDER BY created_at_ms DESC, trace_id ASC LIMIT ?`
        )
        .all(limit)
        .map(mapTraceRow)
    );
  } catch (cause) {
    return traceReadError(cause, "Failed to list retrieval traces");
  }
};

export const finalizeTrace = (
  db: Database,
  traceId: string,
  status: RetrievalTraceTerminalStatus,
  updatedAtMs: number
): StoreResult<RetrievalTraceAppendResult> => {
  try {
    validateTraceId(traceId, "traceId");
    if (
      !["completed", "partial", "failed", "cancelled"].includes(status) ||
      !Number.isSafeInteger(updatedAtMs) ||
      updatedAtMs < 0
    ) {
      return err("INVALID_INPUT", "Invalid retrieval trace terminal outcome");
    }
    const row = db
      .query<
        { status: string; created_at_ms: number; updated_at_ms: number },
        [string]
      >(
        `SELECT status, created_at_ms, updated_at_ms
         FROM retrieval_traces WHERE trace_id = ?`
      )
      .get(traceId);
    if (!row) return err("NOT_FOUND", `Retrieval trace ${traceId} not found`);
    if (updatedAtMs < row.created_at_ms) {
      return err("INVALID_INPUT", "updatedAtMs precedes trace creation");
    }
    if (row.status !== "open") {
      return row.status === status
        ? ok("duplicate")
        : err(
            "CONSTRAINT_VIOLATION",
            `Retrieval trace already finalized as ${row.status}`
          );
    }
    const update = db.run(
      `UPDATE retrieval_traces SET status = ?, updated_at_ms = ?
       WHERE trace_id = ? AND status = 'open'`,
      [status, updatedAtMs, traceId]
    );
    if (update.changes > 0) return ok("inserted");
    return finalizeTrace(db, traceId, status, updatedAtMs);
  } catch (cause) {
    return traceWriteError(cause, "Failed to finalize retrieval trace");
  }
};

export const appendRun = (
  db: Database,
  input: RetrievalTraceRunInput
): StoreResult<RetrievalTraceAppendResult> => {
  try {
    const run = parseRetrievalTraceRunInput(input);
    const json = canonicalTraceJson(run.payload);
    const bytes = enforceByteLimit(json, 65_536, "Trace run payload");
    const digest = hashTraceCanonical(run);
    const insert = db.run(
      `INSERT OR IGNORE INTO retrieval_trace_runs (
         run_id, trace_id, idempotency_key, kind, payload_json,
         payload_bytes, canonical_digest, created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.runId,
        run.traceId,
        run.idempotencyKey,
        run.kind,
        json,
        bytes,
        digest,
        run.createdAtMs,
      ]
    );
    return ok(
      settleIdempotentInsert(
        db,
        "retrieval_trace_runs",
        "run_id",
        run.runId,
        run.traceId,
        run.idempotencyKey,
        digest,
        insert.changes
      )
    );
  } catch (cause) {
    return traceWriteError(cause, "Failed to append retrieval run");
  }
};

export const appendEvent = (
  db: Database,
  input: RetrievalTraceEventInput
): StoreResult<RetrievalTraceAppendResult> => {
  try {
    const event = parseRetrievalTraceEventInput(input);
    const json = canonicalTraceJson(event.payload);
    const bytes = enforceByteLimit(json, 65_536, "Trace event payload");
    const digest = hashTraceCanonical(event);
    const insert = db.run(
      `INSERT OR IGNORE INTO retrieval_trace_events (
         event_id, trace_id, run_id, idempotency_key, kind, payload_json,
         payload_bytes, canonical_digest, created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.eventId,
        event.traceId,
        event.runId,
        event.idempotencyKey,
        event.kind,
        json,
        bytes,
        digest,
        event.createdAtMs,
      ]
    );
    return ok(
      settleIdempotentInsert(
        db,
        "retrieval_trace_events",
        "event_id",
        event.eventId,
        event.traceId,
        event.idempotencyKey,
        digest,
        insert.changes
      )
    );
  } catch (cause) {
    return traceWriteError(cause, "Failed to append retrieval event");
  }
};

export const appendJudgment = (
  db: Database,
  input: RetrievalTraceJudgmentInput
): StoreResult<RetrievalTraceAppendResult> => {
  try {
    const judgment = parseRetrievalTraceJudgmentInput(input);
    enforceByteLimit(judgment.targetRef, 4096, "Judgment targetRef");
    const json = canonicalTraceJson(judgment.target);
    const bytes = enforceByteLimit(json, 16_384, "Judgment target");
    const digest = hashTraceCanonical(judgment);
    const insert = db.run(
      `INSERT OR IGNORE INTO retrieval_trace_judgments (
         judgment_id, trace_id, run_id, idempotency_key, label,
         target_kind, target_ref, target_json, target_bytes,
         canonical_digest, created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        judgment.judgmentId,
        judgment.traceId,
        judgment.runId,
        judgment.idempotencyKey,
        judgment.label,
        judgment.targetKind,
        judgment.targetRef,
        json,
        bytes,
        digest,
        judgment.createdAtMs,
      ]
    );
    return ok(
      settleIdempotentInsert(
        db,
        "retrieval_trace_judgments",
        "judgment_id",
        judgment.judgmentId,
        judgment.traceId,
        judgment.idempotencyKey,
        digest,
        insert.changes
      )
    );
  } catch (cause) {
    return traceWriteError(cause, "Failed to append retrieval judgment");
  }
};

export const appendExport = (
  db: Database,
  input: RetrievalTraceExportInput
): StoreResult<RetrievalTraceAppendResult> => {
  try {
    const value = parseRetrievalTraceExportInput(input);
    const transaction = db.transaction((): RetrievalTraceAppendResult => {
      db.run(
        `INSERT OR IGNORE INTO retrieval_trace_exports
         (export_id, format, artifact_hash, created_at_ms) VALUES (?, ?, ?, ?)`,
        [value.exportId, value.format, value.artifactHash, value.createdAtMs]
      );
      const manifest = db
        .query<{ format: string; artifact_hash: string }, [string]>(
          `SELECT format, artifact_hash FROM retrieval_trace_exports
           WHERE export_id = ?`
        )
        .get(value.exportId);
      if (
        manifest &&
        (manifest.format !== value.format ||
          manifest.artifact_hash !== value.artifactHash)
      ) {
        throw new RetrievalTraceConflictError(
          "Export ID already exists with different content"
        );
      }
      const linkedExportId =
        manifest === undefined
          ? db
              .query<{ export_id: string }, [string, string]>(
                `SELECT export_id FROM retrieval_trace_exports
                 WHERE format = ? AND artifact_hash = ?`
              )
              .get(value.format, value.artifactHash)?.export_id
          : value.exportId;
      if (!linkedExportId) {
        throw new RetrievalTraceConflictError(
          "Unable to resolve retrieval trace export manifest"
        );
      }
      const link = db.run(
        `INSERT OR IGNORE INTO retrieval_trace_export_traces
         (export_id, trace_id) VALUES (?, ?)`,
        [linkedExportId, value.traceId]
      );
      return link.changes > 0 ? "inserted" : "duplicate";
    });
    return ok(transaction());
  } catch (cause) {
    return traceWriteError(cause, "Failed to append retrieval export");
  }
};
