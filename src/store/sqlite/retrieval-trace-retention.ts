/** Secure deletion, full purge, and deterministic trace retention for SQLite. */

import type { Database } from "bun:sqlite";

import type {
  RetrievalTraceDeleteCounts,
  RetrievalTracePurgeResult,
  RetrievalTraceRetentionPolicy,
  RetrievalTraceRetentionResult,
  StoreResult,
} from "../types";

import { ok } from "../types";
import {
  countTraceContent,
  traceWriteError,
  validateTraceId,
} from "./retrieval-trace-rows";

const DAY_MS = 86_400_000;
const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

interface StorageRow {
  trace_id: string;
  created_at_ms: number;
  expires_at_ms: number;
  total_bytes: number;
  record_count: number;
}

const storageRows = (db: Database): StorageRow[] =>
  db
    .query<StorageRow, []>(
      `WITH run_stats AS (
         SELECT
           trace_id,
           COUNT(*) AS cnt,
           SUM(
             length(CAST(run_id AS BLOB))
             + length(CAST(trace_id AS BLOB))
             + length(CAST(idempotency_key AS BLOB))
             + length(CAST(kind AS BLOB))
             + payload_bytes
             + length(CAST(canonical_digest AS BLOB))
             + 8
           ) AS bytes
         FROM retrieval_trace_runs
         GROUP BY trace_id
       ),
       event_stats AS (
         SELECT
           trace_id,
           COUNT(*) AS cnt,
           SUM(
             length(CAST(event_id AS BLOB))
             + length(CAST(trace_id AS BLOB))
             + length(CAST(COALESCE(run_id, '') AS BLOB))
             + length(CAST(idempotency_key AS BLOB))
             + length(CAST(kind AS BLOB))
             + payload_bytes
             + length(CAST(canonical_digest AS BLOB))
             + 8
           ) AS bytes
         FROM retrieval_trace_events
         GROUP BY trace_id
       ),
       judgment_stats AS (
         SELECT
           trace_id,
           COUNT(*) AS cnt,
           SUM(
             length(CAST(judgment_id AS BLOB))
             + length(CAST(trace_id AS BLOB))
             + length(CAST(COALESCE(run_id, '') AS BLOB))
             + length(CAST(idempotency_key AS BLOB))
             + length(CAST(label AS BLOB))
             + length(CAST(target_kind AS BLOB))
             + length(CAST(target_ref AS BLOB))
             + target_bytes
             + length(CAST(canonical_digest AS BLOB))
             + 8
           ) AS bytes
         FROM retrieval_trace_judgments
         GROUP BY trace_id
       ),
       export_stats AS (
         SELECT
           et.trace_id,
           COUNT(*) AS cnt,
           SUM(
             length(CAST(x.export_id AS BLOB))
             + length(CAST(et.trace_id AS BLOB))
             + length(CAST(x.format AS BLOB))
             + length(CAST(x.artifact_hash AS BLOB))
             + x.egress_lineage_bytes
             + 8
           ) AS bytes
         FROM retrieval_trace_export_traces et
         JOIN retrieval_trace_exports x USING (export_id)
         GROUP BY et.trace_id
       )
       SELECT
         t.trace_id,
         t.created_at_ms,
         t.expires_at_ms,
         (
           length(CAST(t.trace_id AS BLOB))
           + length(CAST(t.schema_version AS BLOB))
           + length(CAST(t.redaction_mode AS BLOB))
           + length(CAST(COALESCE(t.query_text, '') AS BLOB))
           + length(CAST(COALESCE(t.query_digest, '') AS BLOB))
           + length(CAST(t.query_shape_json AS BLOB))
           + length(CAST(COALESCE(t.goal_text, '') AS BLOB))
           + length(CAST(COALESCE(t.goal_digest, '') AS BLOB))
           + length(CAST(t.goal_shape_json AS BLOB))
           + length(CAST(t.filters_json AS BLOB))
           + t.egress_lineage_bytes
           + length(CAST(t.pipeline_fingerprint AS BLOB))
           + length(CAST(t.model_fingerprint AS BLOB))
           + length(CAST(t.config_fingerprint AS BLOB))
           + length(CAST(t.index_fingerprint AS BLOB))
           + length(CAST(t.status AS BLOB))
           + length(CAST(t.creation_digest AS BLOB))
           + 40
         )
           + COALESCE(rs.bytes, 0)
           + COALESCE(es.bytes, 0)
           + COALESCE(js.bytes, 0)
           + COALESCE(xs.bytes, 0) AS total_bytes,
         COALESCE(rs.cnt, 0)
           + COALESCE(es.cnt, 0)
           + COALESCE(js.cnt, 0)
           + COALESCE(xs.cnt, 0) AS record_count
       FROM retrieval_traces t
       LEFT JOIN run_stats rs ON rs.trace_id = t.trace_id
       LEFT JOIN event_stats es ON es.trace_id = t.trace_id
       LEFT JOIN judgment_stats js ON js.trace_id = t.trace_id
       LEFT JOIN export_stats xs ON xs.trace_id = t.trace_id
       ORDER BY t.created_at_ms ASC, t.trace_id ASC`
    )
    .all();

const validatePolicy = (
  policy: RetrievalTraceRetentionPolicy,
  nowMs: number
): void => {
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    !Number.isSafeInteger(policy.maxAgeDays) ||
    policy.maxAgeDays < 1 ||
    policy.maxAgeDays > 3650 ||
    !Number.isSafeInteger(policy.maxTraces) ||
    policy.maxTraces < 1 ||
    policy.maxTraces > 1_000_000 ||
    !Number.isSafeInteger(policy.maxRecordsPerTrace) ||
    policy.maxRecordsPerTrace < 1 ||
    policy.maxRecordsPerTrace > 100_000 ||
    !Number.isSafeInteger(policy.maxBytes) ||
    policy.maxBytes < 65_536 ||
    policy.maxBytes > 1024 * 1024 * 1024
  ) {
    throw new RangeError("Invalid retrieval trace retention policy");
  }
};

const subtractCounts = (
  before: RetrievalTraceDeleteCounts,
  after: RetrievalTraceDeleteCounts
): RetrievalTraceDeleteCounts => ({
  traces: before.traces - after.traces,
  runs: before.runs - after.runs,
  events: before.events - after.events,
  judgments: before.judgments - after.judgments,
  exports: before.exports - after.exports,
  exportLinks: before.exportLinks - after.exportLinks,
});

const readSecureDelete = (db: Database): number =>
  db.query<{ secure_delete: number }, []>("PRAGMA secure_delete").get()
    ?.secure_delete ?? 0;

const restoreSecureDelete = (db: Database, prior: number): void => {
  const mode = prior === 0 ? "OFF" : prior === 2 ? "FAST" : "ON";
  db.exec(`PRAGMA secure_delete = ${mode}`);
};

export const deleteTrace = (
  db: Database,
  traceId: string
): StoreResult<RetrievalTraceDeleteCounts> => {
  const prior = readSecureDelete(db);
  try {
    validateTraceId(traceId, "traceId");
    db.exec("PRAGMA secure_delete = ON");
    const transaction = db.transaction(() => {
      const counts = countTraceContent(db, traceId);
      db.run("DELETE FROM retrieval_traces WHERE trace_id = ?", [traceId]);
      return counts;
    });
    return ok(transaction());
  } catch (cause) {
    return traceWriteError(cause, "Failed to delete retrieval trace");
  } finally {
    restoreSecureDelete(db, prior);
  }
};

export const purgeTraces = (
  db: Database
): StoreResult<RetrievalTracePurgeResult> => {
  const prior = readSecureDelete(db);
  try {
    db.exec("PRAGMA secure_delete = ON");
    const transaction = db.transaction(() => {
      const counts = countTraceContent(db);
      db.run("DELETE FROM retrieval_traces");
      db.run(
        `DELETE FROM retrieval_trace_exports WHERE NOT EXISTS (
           SELECT 1 FROM retrieval_trace_export_traces et
           WHERE et.export_id = retrieval_trace_exports.export_id
         )`
      );
      return counts;
    });
    const counts = transaction();
    let checkpoint:
      | { busy: number; log: number; checkpointed: number }
      | undefined;
    try {
      checkpoint =
        db
          .query<{ busy: number; log: number; checkpointed: number }, []>(
            "PRAGMA wal_checkpoint(TRUNCATE)"
          )
          .get() ?? undefined;
    } catch {
      return ok({
        ...counts,
        physicalCleanup: "failed",
        checkpointedFrames: 0,
        remainingWalFrames: -1,
      });
    }
    const physicalCleanup =
      checkpoint?.busy === 0 && (checkpoint.log === 0 || checkpoint.log === -1)
        ? "completed"
        : "wal_busy";
    return ok({
      ...counts,
      physicalCleanup,
      checkpointedFrames: checkpoint?.checkpointed ?? 0,
      remainingWalFrames: checkpoint?.log ?? -1,
    });
  } catch (cause) {
    return traceWriteError(cause, "Failed to purge retrieval traces");
  } finally {
    restoreSecureDelete(db, prior);
  }
};

export const enforceRetention = (
  db: Database,
  policy: RetrievalTraceRetentionPolicy,
  nowMs: number
): StoreResult<RetrievalTraceRetentionResult> => {
  const prior = readSecureDelete(db);
  try {
    validatePolicy(policy, nowMs);
    db.exec("PRAGMA secure_delete = ON");
    db.exec("BEGIN IMMEDIATE");
    try {
      const before = countTraceContent(db);
      const rows = storageRows(db);
      const ageMs = policy.maxAgeDays * DAY_MS;
      const byExpiry = [...rows].sort((left, right) => {
        const leftExpiry = Math.min(
          left.expires_at_ms,
          left.created_at_ms + ageMs
        );
        const rightExpiry = Math.min(
          right.expires_at_ms,
          right.created_at_ms + ageMs
        );
        return (
          leftExpiry - rightExpiry ||
          left.created_at_ms - right.created_at_ms ||
          compareCodeUnits(left.trace_id, right.trace_id)
        );
      });
      const deleted = new Set<string>();
      const deletedTraceIds: string[] = [];
      let remainingTraces = rows.length;
      let remainingBytes = rows.reduce(
        (total, row) => total + row.total_bytes,
        0
      );

      const deleteTraceStmt = db.query<unknown, [string]>(
        "DELETE FROM retrieval_traces WHERE trace_id = ?"
      );

      for (const row of byExpiry) {
        const effectiveExpiry = Math.min(
          row.expires_at_ms,
          row.created_at_ms + ageMs
        );
        if (effectiveExpiry > nowMs) break;
        deleteTraceStmt.run(row.trace_id);
        deleted.add(row.trace_id);
        deletedTraceIds.push(row.trace_id);
        remainingTraces -= 1;
        remainingBytes -= row.total_bytes;
      }

      for (const row of rows) {
        if (
          deleted.has(row.trace_id) ||
          row.record_count <= policy.maxRecordsPerTrace
        ) {
          continue;
        }
        deleteTraceStmt.run(row.trace_id);
        deleted.add(row.trace_id);
        deletedTraceIds.push(row.trace_id);
        remainingTraces -= 1;
        remainingBytes -= row.total_bytes;
      }

      for (const row of rows) {
        if (
          remainingTraces <= policy.maxTraces &&
          remainingBytes <= policy.maxBytes
        ) {
          break;
        }
        if (deleted.has(row.trace_id)) continue;
        deleteTraceStmt.run(row.trace_id);
        deleted.add(row.trace_id);
        deletedTraceIds.push(row.trace_id);
        remainingTraces -= 1;
        remainingBytes -= row.total_bytes;
      }

      const after = countTraceContent(db);
      db.exec("COMMIT");
      return ok({
        deleted: subtractCounts(before, after),
        deletedTraceIds,
        remainingTraces,
        remainingBytes,
      });
    } catch (cause) {
      db.exec("ROLLBACK");
      throw cause;
    }
  } catch (cause) {
    return traceWriteError(cause, "Failed to enforce trace retention");
  } finally {
    restoreSecureDelete(db, prior);
  }
};
