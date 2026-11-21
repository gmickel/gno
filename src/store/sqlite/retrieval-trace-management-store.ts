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

import {
  egressLineageSchema,
  mergeEgressLineages,
} from "../../core/egress-provenance";
import { canonicalTraceJson, traceUtf8Bytes } from "../retrieval-trace-codec";
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
        const fetchLimit = detailLimit + 1;
        const runsRaw = db
          .query<DbRetrievalTraceRunRow, [string, number]>(
            `SELECT * FROM retrieval_trace_runs WHERE trace_id = ?
             ORDER BY created_at_ms, run_id LIMIT ?`
          )
          .all(traceId, fetchLimit);
        const eventsRaw = db
          .query<DbRetrievalTraceEventRow, [string, number]>(
            `SELECT * FROM retrieval_trace_events WHERE trace_id = ?
             ORDER BY created_at_ms, event_id LIMIT ?`
          )
          .all(traceId, fetchLimit);
        const judgmentsRaw = db
          .query<DbRetrievalTraceJudgmentRow, [string, number]>(
            `SELECT * FROM retrieval_trace_judgments WHERE trace_id = ?
             ORDER BY created_at_ms, judgment_id LIMIT ?`
          )
          .all(traceId, fetchLimit);
        const exportsRaw = db
          .query<DbRetrievalTraceExportRow, [string, number]>(
            `SELECT x.*, et.trace_id FROM retrieval_trace_exports x
             JOIN retrieval_trace_export_traces et USING (export_id)
             WHERE et.trace_id = ?
             ORDER BY x.created_at_ms, x.export_id LIMIT ?`
          )
          .all(traceId, fetchLimit);
        const runs =
          runsRaw.length > detailLimit
            ? runsRaw.slice(0, detailLimit)
            : runsRaw;
        const events =
          eventsRaw.length > detailLimit
            ? eventsRaw.slice(0, detailLimit)
            : eventsRaw;
        const judgments =
          judgmentsRaw.length > detailLimit
            ? judgmentsRaw.slice(0, detailLimit)
            : judgmentsRaw;
        const exports =
          exportsRaw.length > detailLimit
            ? exportsRaw.slice(0, detailLimit)
            : exportsRaw;
        return {
          bundle: {
            trace: mapTraceRow(trace),
            runs: runs.map(mapRunRow),
            events: events.map(mapEventRow),
            judgments: judgments.map(mapJudgmentRow),
            exports: exports.map(mapExportRow),
          },
          totals: {
            runs:
              runsRaw.length > detailLimit
                ? countForTrace(db, "retrieval_trace_runs", traceId)
                : runs.length,
            events:
              eventsRaw.length > detailLimit
                ? countForTrace(db, "retrieval_trace_events", traceId)
                : events.length,
            judgments:
              judgmentsRaw.length > detailLimit
                ? countForTrace(db, "retrieval_trace_judgments", traceId)
                : judgments.length,
            exports:
              exportsRaw.length > detailLimit
                ? countForTrace(db, "retrieval_trace_export_traces", traceId)
                : exports.length,
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
  return {
    ...input,
    traceIds,
    egressLineage: egressLineageSchema.parse(input.egressLineage),
  };
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
        egress_lineage_json: string;
      },
      [string]
    >(
      `SELECT export_id, format, artifact_hash, created_at_ms,
              egress_lineage_json
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
    egressLineage: egressLineageSchema.parse(
      JSON.parse(row.egress_lineage_json)
    ),
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
      const traceRows = db
        .query<
          { trace_id: string; status: string; egress_lineage_json: string },
          [string]
        >(
          `SELECT trace_id, status, egress_lineage_json
           FROM retrieval_traces
           WHERE trace_id IN (SELECT value FROM json_each(?))`
        )
        .all(JSON.stringify(manifest.traceIds));
      const traceById = new Map(traceRows.map((row) => [row.trace_id, row]));
      const sourceLineages = [];
      for (const traceId of manifest.traceIds) {
        const trace = traceById.get(traceId);
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
        sourceLineages.push(
          egressLineageSchema.parse(JSON.parse(trace.egress_lineage_json))
        );
      }
      const aggregateLineage = mergeEgressLineages(sourceLineages);
      const historicalMembership = aggregateLineage.sources
        .map(({ collection }) => collection)
        .join("\0");
      const manifestMembership = manifest.egressLineage.sources
        .map(({ collection }) => collection)
        .join("\0");
      if (historicalMembership !== manifestMembership) {
        throw new RetrievalTraceConflictError(
          "Export manifest collection lineage does not match trace membership"
        );
      }
      const egressLineageJson = canonicalTraceJson(manifest.egressLineage);
      const egressLineageBytes = traceUtf8Bytes(egressLineageJson);
      const inserted = db.run(
        `INSERT OR IGNORE INTO retrieval_trace_exports
         (export_id, format, artifact_hash, created_at_ms,
          effective_egress_policy, egress_lineage_digest,
          egress_lineage_json, egress_lineage_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          manifest.exportId,
          manifest.format,
          manifest.artifactHash,
          manifest.createdAtMs,
          manifest.egressLineage.effectivePolicy,
          manifest.egressLineage.digest,
          egressLineageJson,
          egressLineageBytes,
        ]
      );
      const existing = readManifest(db, manifest.exportId);
      if (
        !existing ||
        existing.format !== manifest.format ||
        existing.artifactHash !== manifest.artifactHash ||
        existing.egressLineage.digest !== manifest.egressLineage.digest
      ) {
        throw new RetrievalTraceConflictError(
          "Export ID already exists with different content"
        );
      }
      const insertExportLink = db.query<unknown, [string, string]>(
        `INSERT OR IGNORE INTO retrieval_trace_export_traces
         (export_id, trace_id) VALUES (?, ?)`
      );
      for (const traceId of manifest.traceIds) {
        insertExportLink.run(manifest.exportId, traceId);
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
        const idsJson = JSON.stringify(manifest.traceIds);
        const traceRows = db
          .query<DbRetrievalTraceRow, [string]>(
            `SELECT * FROM retrieval_traces
             WHERE trace_id IN (SELECT value FROM json_each(?))`
          )
          .all(idsJson);
        const traceById = new Map(traceRows.map((row) => [row.trace_id, row]));
        for (const traceId of manifest.traceIds) {
          if (!traceById.has(traceId)) {
            throw new RetrievalTraceConflictError(
              "Export manifest references a missing retrieval trace"
            );
          }
        }
        const runsByTrace = new Map<string, DbRetrievalTraceRunRow[]>();
        for (const row of db
          .query<DbRetrievalTraceRunRow, [string]>(
            `SELECT * FROM retrieval_trace_runs
             WHERE trace_id IN (SELECT value FROM json_each(?))
             ORDER BY trace_id, created_at_ms, run_id`
          )
          .all(idsJson)) {
          const list = runsByTrace.get(row.trace_id);
          if (list) list.push(row);
          else runsByTrace.set(row.trace_id, [row]);
        }
        const eventsByTrace = new Map<string, DbRetrievalTraceEventRow[]>();
        for (const row of db
          .query<DbRetrievalTraceEventRow, [string]>(
            `SELECT * FROM retrieval_trace_events
             WHERE trace_id IN (SELECT value FROM json_each(?))
             ORDER BY trace_id, created_at_ms, event_id`
          )
          .all(idsJson)) {
          const list = eventsByTrace.get(row.trace_id);
          if (list) list.push(row);
          else eventsByTrace.set(row.trace_id, [row]);
        }
        const judgmentsByTrace = new Map<
          string,
          DbRetrievalTraceJudgmentRow[]
        >();
        for (const row of db
          .query<DbRetrievalTraceJudgmentRow, [string]>(
            `SELECT * FROM retrieval_trace_judgments
             WHERE trace_id IN (SELECT value FROM json_each(?))
             ORDER BY trace_id, created_at_ms, judgment_id`
          )
          .all(idsJson)) {
          const list = judgmentsByTrace.get(row.trace_id);
          if (list) list.push(row);
          else judgmentsByTrace.set(row.trace_id, [row]);
        }
        const exportsByTrace = new Map<string, DbRetrievalTraceExportRow[]>();
        for (const row of db
          .query<DbRetrievalTraceExportRow, [string]>(
            `SELECT x.*, et.trace_id FROM retrieval_trace_exports x
             JOIN retrieval_trace_export_traces et USING (export_id)
             WHERE et.trace_id IN (SELECT value FROM json_each(?))
             ORDER BY et.trace_id, x.created_at_ms, x.export_id`
          )
          .all(idsJson)) {
          const list = exportsByTrace.get(row.trace_id);
          if (list) list.push(row);
          else exportsByTrace.set(row.trace_id, [row]);
        }
        const traces = manifest.traceIds.map((traceId) => ({
          trace: mapTraceRow(traceById.get(traceId)!),
          runs: (runsByTrace.get(traceId) ?? []).map(mapRunRow),
          events: (eventsByTrace.get(traceId) ?? []).map(mapEventRow),
          judgments: (judgmentsByTrace.get(traceId) ?? []).map(mapJudgmentRow),
          exports: (exportsByTrace.get(traceId) ?? []).map(mapExportRow),
        }));
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
