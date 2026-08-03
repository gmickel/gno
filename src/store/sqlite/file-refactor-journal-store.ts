/**
 * SQLite persistence for content-free file-refactor recovery receipts.
 *
 * @module src/store/sqlite/file-refactor-journal-store
 */

import type { Database } from "bun:sqlite";

import type { FileRefactorOperation } from "../../core/file-refactor-contract";
import type {
  FileRefactorJournalAdvance,
  FileRefactorJournalFileEntry,
  FileRefactorJournalFilesystemState,
  FileRefactorJournalIndexState,
  FileRefactorJournalPhase,
  FileRefactorRecoveryReceipt,
  FileRefactorRecoveryReceiptDraft,
} from "../../core/file-refactor-journal";
import type { StoreResult } from "../types";

import {
  assertAllowedJournalPhaseTransition,
  FILE_REFACTOR_JOURNAL_MAX_RECEIPTS,
  FILE_REFACTOR_JOURNAL_PHASE_ORDINAL,
  parseFileRefactorJournalFileEntries,
} from "../../core/file-refactor-journal";
import { err, ok } from "../types";

interface DbRow {
  journal_id: string;
  plan_digest: string;
  collection: string;
  operation: FileRefactorOperation;
  source_rel_path: string;
  target_rel_path: string;
  phase: FileRefactorJournalPhase;
  phase_ordinal: number;
  filesystem_state: FileRefactorJournalFilesystemState;
  index_state: FileRefactorJournalIndexState;
  file_entries_json: string;
  created_at_ms: number;
  updated_at_ms: number;
}

const mapRow = (row: DbRow): FileRefactorRecoveryReceipt => ({
  journalId: row.journal_id,
  planDigest: row.plan_digest,
  collection: row.collection,
  operation: row.operation,
  sourceRelPath: row.source_rel_path,
  targetRelPath: row.target_rel_path,
  phase: row.phase,
  phaseOrdinal: row.phase_ordinal,
  filesystemState: row.filesystem_state,
  indexState: row.index_state,
  fileEntries: parseFileRefactorJournalFileEntries(row.file_entries_json),
  createdAtMs: row.created_at_ms,
  updatedAtMs: row.updated_at_ms,
});

const assertContentFreeEntries = (
  entries: FileRefactorJournalFileEntry[]
): void => {
  const serialized = JSON.stringify(entries);
  if (serialized.length > 65_536) {
    throw new RangeError("File refactor journal entries exceed size bound");
  }
  parseFileRefactorJournalFileEntries(entries);
};

const pruneOldestTerminalReceipts = (db: Database): void => {
  const countRow = db
    .query<{ count: number }, []>(
      `SELECT COUNT(*) AS count FROM file_refactor_recovery_journal`
    )
    .get();
  const count = countRow?.count ?? 0;
  if (count < FILE_REFACTOR_JOURNAL_MAX_RECEIPTS) return;

  const overflow = count - FILE_REFACTOR_JOURNAL_MAX_RECEIPTS + 1;
  db.run(
    `DELETE FROM file_refactor_recovery_journal
     WHERE journal_id IN (
       SELECT journal_id FROM file_refactor_recovery_journal
       WHERE phase IN ('converged', 'rolled_back', 'aborted')
       ORDER BY updated_at_ms ASC, journal_id ASC
       LIMIT ?
     )`,
    [overflow]
  );

  const after = db
    .query<{ count: number }, []>(
      `SELECT COUNT(*) AS count FROM file_refactor_recovery_journal`
    )
    .get();
  if ((after?.count ?? 0) >= FILE_REFACTOR_JOURNAL_MAX_RECEIPTS) {
    throw new Error(
      "File refactor journal at capacity with no prunable terminal receipts"
    );
  }
};

export const createFileRefactorPreparedReceipt = (
  db: Database,
  draft: FileRefactorRecoveryReceiptDraft
): StoreResult<FileRefactorRecoveryReceipt> => {
  try {
    assertContentFreeEntries(draft.fileEntries);
    pruneOldestTerminalReceipts(db);
    const phase: FileRefactorJournalPhase = "prepared";
    const phaseOrdinal = FILE_REFACTOR_JOURNAL_PHASE_ORDINAL[phase];
    const fileEntriesJson = JSON.stringify(draft.fileEntries);
    db.run(
      `INSERT INTO file_refactor_recovery_journal (
         journal_id, plan_digest, collection, operation,
         source_rel_path, target_rel_path, phase, phase_ordinal,
         filesystem_state, index_state, file_entries_json,
         created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unchanged', 'not_attempted', ?, ?, ?)`,
      [
        draft.journalId,
        draft.planDigest,
        draft.collection,
        draft.operation,
        draft.sourceRelPath,
        draft.targetRelPath,
        phase,
        phaseOrdinal,
        fileEntriesJson,
        draft.createdAtMs,
        draft.createdAtMs,
      ]
    );
    const row = db
      .query<DbRow, [string]>(
        `SELECT * FROM file_refactor_recovery_journal WHERE journal_id = ?`
      )
      .get(draft.journalId);
    if (!row) {
      return err("QUERY_FAILED", "Failed to read created refactor receipt");
    }
    return ok(mapRow(row));
  } catch (cause) {
    return err(
      cause instanceof RangeError ||
        (cause instanceof Error && cause.message.includes("Corrupt"))
        ? "INVALID_INPUT"
        : "QUERY_FAILED",
      cause instanceof Error
        ? cause.message
        : "Failed to create file refactor recovery receipt",
      cause
    );
  }
};

export const advanceFileRefactorReceipt = (
  db: Database,
  journalId: string,
  update: FileRefactorJournalAdvance
): StoreResult<FileRefactorRecoveryReceipt> => {
  try {
    const existing = db
      .query<DbRow, [string]>(
        `SELECT * FROM file_refactor_recovery_journal WHERE journal_id = ?`
      )
      .get(journalId);
    if (!existing) {
      return err(
        "NOT_FOUND",
        `Refactor recovery receipt not found: ${journalId}`
      );
    }
    assertAllowedJournalPhaseTransition(existing.phase, update.phase);
    if (update.updatedAtMs < existing.updated_at_ms) {
      return err("INVALID_INPUT", "Journal updatedAtMs must be monotonic");
    }
    const fileEntries =
      update.fileEntries ??
      parseFileRefactorJournalFileEntries(existing.file_entries_json);
    assertContentFreeEntries(fileEntries);
    const phaseOrdinal = FILE_REFACTOR_JOURNAL_PHASE_ORDINAL[update.phase];
    const filesystemState = update.filesystemState ?? existing.filesystem_state;
    const indexState = update.indexState ?? existing.index_state;
    db.run(
      `UPDATE file_refactor_recovery_journal
       SET phase = ?,
           phase_ordinal = ?,
           filesystem_state = ?,
           index_state = ?,
           file_entries_json = ?,
           updated_at_ms = ?
       WHERE journal_id = ?`,
      [
        update.phase,
        phaseOrdinal,
        filesystemState,
        indexState,
        JSON.stringify(fileEntries),
        update.updatedAtMs,
        journalId,
      ]
    );
    const row = db
      .query<DbRow, [string]>(
        `SELECT * FROM file_refactor_recovery_journal WHERE journal_id = ?`
      )
      .get(journalId);
    if (!row) {
      return err("QUERY_FAILED", "Failed to read updated refactor receipt");
    }
    return ok(mapRow(row));
  } catch (cause) {
    return err(
      cause instanceof RangeError ||
        (cause instanceof Error &&
          (cause.message.includes("Corrupt") ||
            cause.message.includes("Invalid journal phase")))
        ? "INVALID_INPUT"
        : "QUERY_FAILED",
      cause instanceof Error
        ? cause.message
        : "Failed to advance file refactor recovery receipt",
      cause
    );
  }
};

export const getFileRefactorReceiptById = (
  db: Database,
  journalId: string
): StoreResult<FileRefactorRecoveryReceipt | null> => {
  try {
    const row = db
      .query<DbRow, [string]>(
        `SELECT * FROM file_refactor_recovery_journal WHERE journal_id = ?`
      )
      .get(journalId);
    return ok(row ? mapRow(row) : null);
  } catch (cause) {
    return err(
      "QUERY_FAILED",
      cause instanceof Error
        ? cause.message
        : "Failed to load file refactor recovery receipt",
      cause
    );
  }
};

export const getLatestFileRefactorReceiptByPlanDigest = (
  db: Database,
  planDigest: string
): StoreResult<FileRefactorRecoveryReceipt | null> => {
  try {
    const row = db
      .query<DbRow, [string]>(
        `SELECT * FROM file_refactor_recovery_journal
         WHERE plan_digest = ?
         ORDER BY updated_at_ms DESC, journal_id DESC
         LIMIT 1`
      )
      .get(planDigest);
    return ok(row ? mapRow(row) : null);
  } catch (cause) {
    return err(
      "QUERY_FAILED",
      cause instanceof Error
        ? cause.message
        : "Failed to lookup file refactor recovery receipt",
      cause
    );
  }
};
