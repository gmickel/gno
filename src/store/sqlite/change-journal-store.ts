/** SQLite persistence for the bounded, metadata-only document change journal. */

import type { Database } from "bun:sqlite";

import type {
  DocumentChangeKind,
  DocumentChangeListOptions,
  DocumentChangePage,
  DocumentChangePurgeResult,
  DocumentChangeRetentionPolicy,
  DocumentChangeRetentionResult,
  DocumentChangeRow,
  DocumentChangeStructureDelta,
  DocumentRow,
  StoreResult,
} from "../types";

import {
  decodeDocumentChangeCursor,
  DEFAULT_DOCUMENT_CHANGE_RETENTION,
  encodeDocumentChangeCursor,
  serializeDocumentChangeStructureDelta,
  validateDocumentChangeRetentionPolicy,
} from "../../core/change-journal";
import { err, ok } from "../types";

const DAY_MS = 86_400_000;
const MAX_PAGE_SIZE = 1_000;
const RETENTION_DELETE_SCAN_BATCH_SIZE = 256;
const UTF8_ENCODER = new TextEncoder();

export interface DocumentChangeSnapshot {
  id: number;
  collection: string;
  relPath: string;
  docid: string;
  uri: string;
  sourceHash: string;
  mirrorHash: string | null;
  active: boolean;
}

export interface DocumentChangeDraft {
  documentId: number;
  collection: string;
  kind: DocumentChangeKind;
  oldSnapshot: DocumentChangeSnapshot | null;
  newSnapshot: DocumentChangeSnapshot | null;
  structureDelta?: Partial<DocumentChangeStructureDelta>;
  observedAtMs: number;
}

interface DbDocumentChangeRow {
  sequence: number;
  document_id: number;
  collection: string;
  change_kind: DocumentChangeKind;
  old_rel_path: string | null;
  new_rel_path: string | null;
  old_docid: string | null;
  new_docid: string | null;
  old_uri: string | null;
  new_uri: string | null;
  old_source_hash: string | null;
  new_source_hash: string | null;
  old_mirror_hash: string | null;
  new_mirror_hash: string | null;
  old_active: number | null;
  new_active: number | null;
  heading_delta_json: string;
  link_delta_json: string;
  typed_edge_delta_json: string;
  date_delta_json: string;
  structure_truncated: number;
  observed_at_ms: number;
  byte_size: number;
}

const utf8ByteLength = (value: string | null): number =>
  value === null ? 0 : UTF8_ENCODER.encode(value).byteLength;

const byteSize = (
  draft: DocumentChangeDraft,
  deltaJson: readonly string[]
): number => {
  const old = draft.oldSnapshot;
  const next = draft.newSnapshot;
  return (
    32 +
    utf8ByteLength(draft.collection) +
    utf8ByteLength(draft.kind) +
    utf8ByteLength(old?.relPath ?? null) +
    utf8ByteLength(next?.relPath ?? null) +
    utf8ByteLength(old?.docid ?? null) +
    utf8ByteLength(next?.docid ?? null) +
    utf8ByteLength(old?.uri ?? null) +
    utf8ByteLength(next?.uri ?? null) +
    utf8ByteLength(old?.sourceHash ?? null) +
    utf8ByteLength(next?.sourceHash ?? null) +
    utf8ByteLength(old?.mirrorHash ?? null) +
    utf8ByteLength(next?.mirrorHash ?? null) +
    deltaJson.reduce((total, value) => total + utf8ByteLength(value), 0)
  );
};

const mapRow = (row: DbDocumentChangeRow): DocumentChangeRow => ({
  sequence: row.sequence,
  documentId: row.document_id,
  collection: row.collection,
  kind: row.change_kind,
  oldRelPath: row.old_rel_path,
  newRelPath: row.new_rel_path,
  oldDocid: row.old_docid,
  newDocid: row.new_docid,
  oldUri: row.old_uri,
  newUri: row.new_uri,
  oldSourceHash: row.old_source_hash,
  newSourceHash: row.new_source_hash,
  oldMirrorHash: row.old_mirror_hash,
  newMirrorHash: row.new_mirror_hash,
  oldActive: row.old_active === null ? null : row.old_active === 1,
  newActive: row.new_active === null ? null : row.new_active === 1,
  structureDelta: {
    headings: JSON.parse(row.heading_delta_json),
    links: JSON.parse(row.link_delta_json),
    typedEdges: JSON.parse(row.typed_edge_delta_json),
    dates: JSON.parse(row.date_delta_json),
    truncated: row.structure_truncated === 1,
  },
  observedAtMs: row.observed_at_ms,
  byteSize: row.byte_size,
});

export const snapshotDocumentChange = (
  row: DocumentRow
): DocumentChangeSnapshot => ({
  id: row.id,
  collection: row.collection,
  relPath: row.relPath,
  docid: row.docid,
  uri: row.uri,
  sourceHash: row.sourceHash,
  mirrorHash: row.mirrorHash,
  active: row.active,
});

const enforceInTransaction = (
  db: Database,
  policy: DocumentChangeRetentionPolicy,
  nowMs: number
): DocumentChangeRetentionResult => {
  validateDocumentChangeRetentionPolicy(policy, nowMs);
  const state = db
    .query<
      {
        retained_entries: number;
        retained_bytes: number;
        retention_floor: number;
      },
      []
    >(
      `SELECT retained_entries, retained_bytes, retention_floor
       FROM document_change_journal_state
       WHERE singleton_id = 1`
    )
    .get() ?? {
    retained_entries: 0,
    retained_bytes: 0,
    retention_floor: 0,
  };
  const ageBoundary = nowMs - policy.maxAgeDays * DAY_MS;
  const ageCutoff =
    db
      .query<{ sequence: number | null }, [number]>(
        `SELECT MAX(sequence) AS sequence
         FROM document_changes
         WHERE observed_at_ms <= ?`
      )
      .get(ageBoundary)?.sequence ?? state.retention_floor;
  let deleted = 0;
  let deletedBytes = 0;
  let retentionFloor = state.retention_floor;
  let afterSequence = state.retention_floor;

  retentionScan: while (
    state.retained_entries - deleted > policy.maxEntries ||
    state.retained_bytes - deletedBytes > policy.maxBytes ||
    afterSequence < ageCutoff
  ) {
    const rows = db
      .query<{ sequence: number; byte_size: number }, [number, number]>(
        `SELECT sequence, byte_size
         FROM document_changes
         WHERE sequence > ?
         ORDER BY sequence ASC
         LIMIT ?`
      )
      .all(afterSequence, RETENTION_DELETE_SCAN_BATCH_SIZE);
    if (rows.length === 0) break;

    for (const row of rows) {
      const overEntries = state.retained_entries - deleted > policy.maxEntries;
      const overBytes = state.retained_bytes - deletedBytes > policy.maxBytes;
      if (!(row.sequence <= ageCutoff || overEntries || overBytes)) {
        break retentionScan;
      }
      deleted += 1;
      deletedBytes += row.byte_size;
      retentionFloor = row.sequence;
      afterSequence = row.sequence;
    }
  }

  if (deleted > 0) {
    db.run("DELETE FROM document_changes WHERE sequence <= ?", [
      retentionFloor,
    ]);
    db.run(
      `UPDATE document_change_journal_state
       SET retention_floor = MAX(retention_floor, ?),
           retained_entries = retained_entries - ?,
           retained_bytes = retained_bytes - ?
       WHERE singleton_id = 1`,
      [retentionFloor, deleted, deletedBytes]
    );
  }

  return {
    deleted,
    remainingEntries: state.retained_entries - deleted,
    remainingBytes: state.retained_bytes - deletedBytes,
    earliestCursor: encodeDocumentChangeCursor(retentionFloor),
  };
};

export const appendDocumentChange = (
  db: Database,
  draft: DocumentChangeDraft
): void => {
  if (!Number.isSafeInteger(draft.observedAtMs) || draft.observedAtMs < 0) {
    throw new RangeError("Document change observedAtMs must be non-negative");
  }
  const {
    delta,
    headingDeltaJson,
    linkDeltaJson,
    typedEdgeDeltaJson,
    dateDeltaJson,
  } = serializeDocumentChangeStructureDelta(draft.structureDelta);
  const old = draft.oldSnapshot;
  const next = draft.newSnapshot;
  const storedByteSize = byteSize(draft, [
    headingDeltaJson,
    linkDeltaJson,
    typedEdgeDeltaJson,
    dateDeltaJson,
  ]);
  const inserted = db.run(
    `INSERT INTO document_changes (
       document_id, collection, change_kind,
       old_rel_path, new_rel_path, old_docid, new_docid, old_uri, new_uri,
       old_source_hash, new_source_hash, old_mirror_hash, new_mirror_hash,
       old_active, new_active, heading_delta_json, link_delta_json,
       typed_edge_delta_json, date_delta_json, structure_truncated,
       observed_at_ms, byte_size
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      draft.documentId,
      draft.collection,
      draft.kind,
      old?.relPath ?? null,
      next?.relPath ?? null,
      old?.docid ?? null,
      next?.docid ?? null,
      old?.uri ?? null,
      next?.uri ?? null,
      old?.sourceHash ?? null,
      next?.sourceHash ?? null,
      old?.mirrorHash ?? null,
      next?.mirrorHash ?? null,
      old === null ? null : old.active ? 1 : 0,
      next === null ? null : next.active ? 1 : 0,
      headingDeltaJson,
      linkDeltaJson,
      typedEdgeDeltaJson,
      dateDeltaJson,
      delta.truncated ? 1 : 0,
      draft.observedAtMs,
      storedByteSize,
    ]
  );
  db.run(
    `UPDATE document_change_journal_state
     SET last_sequence = ?,
         retained_entries = retained_entries + 1,
         retained_bytes = retained_bytes + ?
     WHERE singleton_id = 1`,
    [Number(inserted.lastInsertRowid), storedByteSize]
  );
  enforceInTransaction(
    db,
    DEFAULT_DOCUMENT_CHANGE_RETENTION,
    draft.observedAtMs
  );
};

export const listDocumentChanges = (
  db: Database,
  options: DocumentChangeListOptions = {}
): StoreResult<DocumentChangePage> => {
  try {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      return err(
        "INVALID_INPUT",
        `Document change limit must be between 1 and ${MAX_PAGE_SIZE}`
      );
    }
    if (
      options.documentId !== undefined &&
      (!Number.isSafeInteger(options.documentId) || options.documentId < 1)
    ) {
      return err("INVALID_INPUT", "Document id must be a positive integer");
    }
    if (
      options.observedAfterMs !== undefined &&
      (!Number.isSafeInteger(options.observedAfterMs) ||
        options.observedAfterMs < 0)
    ) {
      return err(
        "INVALID_INPUT",
        "Document change observedAfterMs must be a non-negative integer"
      );
    }

    const state = db
      .query<{ last_sequence: number; retention_floor: number }, []>(
        `SELECT last_sequence, retention_floor
         FROM document_change_journal_state
         WHERE singleton_id = 1`
      )
      .get() ?? { last_sequence: 0, retention_floor: 0 };
    const cursorSequence =
      options.cursor === undefined
        ? state.retention_floor
        : decodeDocumentChangeCursor(options.cursor);
    const earliestCursor = encodeDocumentChangeCursor(state.retention_floor);
    const latestCursor = encodeDocumentChangeCursor(state.last_sequence);
    if (cursorSequence < state.retention_floor) {
      return ok({
        changes: [],
        nextCursor: null,
        earliestCursor,
        latestCursor,
        cursorExpired: true,
        truncated: false,
      });
    }
    if (cursorSequence > state.last_sequence) {
      return err(
        "INVALID_INPUT",
        "Document change cursor is ahead of the journal"
      );
    }

    const conditions = ["sequence > ?"];
    const params: (number | string)[] = [cursorSequence];
    if (options.collection) {
      conditions.push("collection = ?");
      params.push(options.collection);
    }
    if (options.documentId !== undefined) {
      conditions.push("document_id = ?");
      params.push(options.documentId);
    }
    if (options.observedAfterMs !== undefined) {
      conditions.push("observed_at_ms >= ?");
      params.push(options.observedAfterMs);
    }
    const rows = db
      .query<DbDocumentChangeRow, (number | string)[]>(
        `SELECT *
         FROM document_changes
         WHERE ${conditions.join(" AND ")}
         ORDER BY sequence ASC
         LIMIT ?`
      )
      .all(...params, limit + 1);
    const truncated = rows.length > limit;
    const selected = rows.slice(0, limit).map(mapRow);
    const lastReturned = selected.at(-1);
    return ok({
      changes: selected,
      nextCursor:
        truncated && lastReturned
          ? encodeDocumentChangeCursor(lastReturned.sequence)
          : null,
      earliestCursor,
      latestCursor,
      cursorExpired: false,
      truncated,
    });
  } catch (cause) {
    const invalidCursor =
      cause instanceof TypeError &&
      cause.message === "Invalid document change cursor";
    return err(
      invalidCursor ? "INVALID_INPUT" : "QUERY_FAILED",
      cause instanceof Error
        ? cause.message
        : "Failed to list document changes",
      cause
    );
  }
};

export const enforceDocumentChangeRetention = (
  db: Database,
  policy: DocumentChangeRetentionPolicy,
  nowMs: number
): StoreResult<DocumentChangeRetentionResult> => {
  try {
    const transaction = db.transaction(() =>
      enforceInTransaction(db, policy, nowMs)
    );
    return ok(transaction());
  } catch (cause) {
    return err(
      cause instanceof RangeError ? "INVALID_INPUT" : "QUERY_FAILED",
      cause instanceof Error
        ? cause.message
        : "Failed to enforce document change retention",
      cause
    );
  }
};

export const purgeDocumentChanges = (
  db: Database
): StoreResult<DocumentChangePurgeResult> => {
  try {
    const transaction = db.transaction((): DocumentChangePurgeResult => {
      const state = db
        .query<{ last_sequence: number }, []>(
          `SELECT last_sequence
           FROM document_change_journal_state
           WHERE singleton_id = 1`
        )
        .get() ?? { last_sequence: 0 };
      const deleted = db.run("DELETE FROM document_changes").changes;
      db.run(
        `UPDATE document_change_journal_state
         SET retention_floor = last_sequence,
             retained_entries = 0,
             retained_bytes = 0
         WHERE singleton_id = 1`
      );
      return {
        deleted,
        earliestCursor: encodeDocumentChangeCursor(state.last_sequence),
      };
    });
    return ok(transaction());
  } catch (cause) {
    return err(
      "QUERY_FAILED",
      cause instanceof Error
        ? cause.message
        : "Failed to purge document changes",
      cause
    );
  }
};
