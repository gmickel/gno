/** SQLite primitives used by local retrieval-trace management surfaces. */

import type { Database } from "bun:sqlite";

import type {
  RetrievalTraceAppendResult,
  RetrievalTraceBoundedBundle,
  RetrievalTraceExportBundle,
  RetrievalTraceExportManifestInput,
  RetrievalTraceExportManifestRow,
  StoreResult,
} from "../types";

import { ok } from "../types";
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
import { getTrace } from "./retrieval-trace-store";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REDACTION_SECRET_KEY = "retrieval_trace_redaction_secret_v1";

const randomSecret = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
};

const countForTrace = (db: Database, table: string, traceId: string): number =>
  db
    .query<{ count: number }, [string]>(
      `SELECT COUNT(*) AS count FROM ${table} WHERE trace_id = ?`
    )
    .get(traceId)?.count ?? 0;

export const getBoundedTrace = (
  db: Database,
  traceId: string,
  detailLimit: number
): StoreResult<RetrievalTraceBoundedBundle | null> => {
  try {
    validateTraceId(traceId, "traceId");
    if (
      !Number.isSafeInteger(detailLimit) ||
      detailLimit < 1 ||
      detailLimit > 10_000
    ) {
      throw new RangeError("Trace detail limit must be from 1 to 10000");
    }
    const transaction = db.transaction(
      (): RetrievalTraceBoundedBundle | null => {
        const trace = db
          .query<DbRetrievalTraceRow, [string]>(
            "SELECT * FROM retrieval_traces WHERE trace_id = ?"
          )
          .get(traceId);
        if (!trace) return null;
        const runs = db
          .query<DbRetrievalTraceRunRow, [string, number]>(
            `SELECT * FROM retrieval_trace_runs WHERE trace_id = ?
             ORDER BY created_at_ms, run_id LIMIT ?`
          )
          .all(traceId, detailLimit);
        const events = db
          .query<DbRetrievalTraceEventRow, [string, number]>(
            `SELECT * FROM retrieval_trace_events WHERE trace_id = ?
             ORDER BY created_at_ms, event_id LIMIT ?`
          )
          .all(traceId, detailLimit);
        const judgments = db
          .query<DbRetrievalTraceJudgmentRow, [string, number]>(
            `SELECT * FROM retrieval_trace_judgments WHERE trace_id = ?
             ORDER BY created_at_ms, judgment_id LIMIT ?`
          )
          .all(traceId, detailLimit);
        const exports = db
          .query<DbRetrievalTraceExportRow, [string, number]>(
            `SELECT x.*, et.trace_id FROM retrieval_trace_exports x
             JOIN retrieval_trace_export_traces et USING (export_id)
             WHERE et.trace_id = ?
             ORDER BY x.created_at_ms, x.export_id LIMIT ?`
          )
          .all(traceId, detailLimit);
        return {
          bundle: {
            trace: mapTraceRow(trace),
            runs: runs.map(mapRunRow),
            events: events.map(mapEventRow),
            judgments: judgments.map(mapJudgmentRow),
            exports: exports.map(mapExportRow),
          },
          totals: {
            runs: countForTrace(db, "retrieval_trace_runs", traceId),
            events: countForTrace(db, "retrieval_trace_events", traceId),
            judgments: countForTrace(db, "retrieval_trace_judgments", traceId),
            exports: countForTrace(
              db,
              "retrieval_trace_export_traces",
              traceId
            ),
          },
        };
      }
    );
    return ok(transaction());
  } catch (cause) {
    return traceReadError(cause, "Failed to get bounded retrieval trace");
  }
};

const normalizeManifest = (
  input: RetrievalTraceExportManifestInput
): RetrievalTraceExportManifestInput => {
  validateTraceId(input.exportId, "exportId");
  if (!["agentic-receipt", "qrels"].includes(input.format)) {
    throw new RangeError("Invalid retrieval trace export format");
  }
  if (!SHA256_PATTERN.test(input.artifactHash)) {
    throw new RangeError("artifactHash must be a lowercase SHA-256 digest");
  }
  if (!Number.isSafeInteger(input.createdAtMs) || input.createdAtMs < 0) {
    throw new RangeError("createdAtMs must be epoch milliseconds");
  }
  if (input.traceIds.length < 1 || input.traceIds.length > 10_000) {
    throw new RangeError("Export manifests require from 1 to 10000 traces");
  }
  const traceIds = [...new Set(input.traceIds)].sort();
  for (const traceId of traceIds) validateTraceId(traceId, "traceId");
  return { ...input, traceIds };
};

const readManifest = (
  db: Database,
  exportId: string
): RetrievalTraceExportManifestRow | null => {
  const row = db
    .query<
      {
        export_id: string;
        format: RetrievalTraceExportManifestRow["format"];
        artifact_hash: string;
        created_at_ms: number;
      },
      [string]
    >(
      `SELECT export_id, format, artifact_hash, created_at_ms
       FROM retrieval_trace_exports WHERE export_id = ?`
    )
    .get(exportId);
  if (!row) return null;
  const traceIds = db
    .query<{ trace_id: string }, [string]>(
      `SELECT trace_id FROM retrieval_trace_export_traces
       WHERE export_id = ? ORDER BY trace_id`
    )
    .all(exportId)
    .map(({ trace_id }) => trace_id);
  return {
    exportId: row.export_id,
    traceIds,
    format: row.format,
    artifactHash: row.artifact_hash,
    createdAtMs: row.created_at_ms,
  };
};

export const getOrCreateRedactionSecret = (
  db: Database
): StoreResult<string> => {
  try {
    const candidate = randomSecret();
    const transaction = db.transaction((): string => {
      db.run(
        `INSERT OR IGNORE INTO schema_meta (key, value, updated_at)
         VALUES (?, ?, datetime('now'))`,
        [REDACTION_SECRET_KEY, candidate]
      );
      const stored = db
        .query<{ value: string }, [string]>(
          "SELECT value FROM schema_meta WHERE key = ?"
        )
        .get(REDACTION_SECRET_KEY)?.value;
      if (!stored || !SHA256_PATTERN.test(stored)) {
        throw new RetrievalTraceConflictError(
          "Invalid retrieval trace redaction secret"
        );
      }
      return stored;
    });
    return ok(transaction());
  } catch (cause) {
    return traceWriteError(
      cause,
      "Failed to load retrieval trace redaction secret"
    );
  }
};

export const appendExportManifest = (
  db: Database,
  input: RetrievalTraceExportManifestInput
): StoreResult<RetrievalTraceAppendResult> => {
  try {
    const manifest = normalizeManifest(input);
    const transaction = db.transaction((): RetrievalTraceAppendResult => {
      const hashOwner = db
        .query<{ export_id: string }, [string, string]>(
          `SELECT export_id FROM retrieval_trace_exports
           WHERE format = ? AND artifact_hash = ?`
        )
        .get(manifest.format, manifest.artifactHash)?.export_id;
      if (hashOwner && hashOwner !== manifest.exportId) {
        throw new RetrievalTraceConflictError(
          "Export artifact already belongs to a different manifest"
        );
      }
      for (const traceId of manifest.traceIds) {
        const trace = db
          .query<{ status: string }, [string]>(
            "SELECT status FROM retrieval_traces WHERE trace_id = ?"
          )
          .get(traceId);
        if (!trace) {
          throw new RetrievalTraceConflictError(
            "Export manifest references a missing retrieval trace"
          );
        }
        if (trace.status === "open") {
          throw new RetrievalTraceConflictError(
            "Open retrieval traces cannot be exported"
          );
        }
      }
      const inserted = db.run(
        `INSERT OR IGNORE INTO retrieval_trace_exports
         (export_id, format, artifact_hash, created_at_ms) VALUES (?, ?, ?, ?)`,
        [
          manifest.exportId,
          manifest.format,
          manifest.artifactHash,
          manifest.createdAtMs,
        ]
      );
      const existing = readManifest(db, manifest.exportId);
      if (
        !existing ||
        existing.format !== manifest.format ||
        existing.artifactHash !== manifest.artifactHash
      ) {
        throw new RetrievalTraceConflictError(
          "Export ID already exists with different content"
        );
      }
      for (const traceId of manifest.traceIds) {
        db.run(
          `INSERT OR IGNORE INTO retrieval_trace_export_traces
           (export_id, trace_id) VALUES (?, ?)`,
          [manifest.exportId, traceId]
        );
      }
      const stored = readManifest(db, manifest.exportId);
      if (
        !stored ||
        stored.traceIds.length !== manifest.traceIds.length ||
        stored.traceIds.some(
          (traceId, index) => traceId !== manifest.traceIds[index]
        )
      ) {
        throw new RetrievalTraceConflictError(
          "Export manifest membership conflicts with stored content"
        );
      }
      return inserted.changes > 0 ? "inserted" : "duplicate";
    });
    return ok(transaction());
  } catch (cause) {
    return traceWriteError(
      cause,
      "Failed to append retrieval trace export manifest"
    );
  }
};

export const getExportManifest = (
  db: Database,
  exportId: string
): StoreResult<RetrievalTraceExportManifestRow | null> => {
  try {
    validateTraceId(exportId, "exportId");
    return ok(readManifest(db, exportId));
  } catch (cause) {
    return traceReadError(cause, "Failed to get retrieval trace export");
  }
};

export const getExportBundle = (
  db: Database,
  exportId: string
): StoreResult<RetrievalTraceExportBundle | null> => {
  try {
    validateTraceId(exportId, "exportId");
    const transaction = db.transaction(
      (): StoreResult<RetrievalTraceExportBundle | null> => {
        const manifest = readManifest(db, exportId);
        if (!manifest) return ok(null);
        const traces = [];
        for (const traceId of manifest.traceIds) {
          const trace = getTrace(db, traceId);
          if (!trace.ok) return trace;
          if (!trace.value) {
            throw new RetrievalTraceConflictError(
              "Export manifest references a missing retrieval trace"
            );
          }
          traces.push(trace.value);
        }
        return ok({ manifest, traces });
      }
    );
    return transaction();
  } catch (cause) {
    return traceReadError(
      cause,
      "Failed to get complete retrieval trace export"
    );
  }
};
