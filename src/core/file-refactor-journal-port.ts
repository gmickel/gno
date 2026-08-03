/**
 * Journal ports and helpers for reference-safe refactor apply.
 *
 * @module src/core/file-refactor-journal-port
 */

import type {
  FileRefactorJournalPort,
  FileRefactorRecoveryReceipt,
} from "./file-refactor-journal";

import {
  assertAllowedJournalPhaseTransition,
  FILE_REFACTOR_JOURNAL_MAX_RECEIPTS,
  FILE_REFACTOR_JOURNAL_PHASE_ORDINAL,
  isPrunableJournalPhase,
} from "./file-refactor-journal";

function pruneOldestTerminalReceipts(
  byId: Map<string, FileRefactorRecoveryReceipt>
): void {
  while (byId.size >= FILE_REFACTOR_JOURNAL_MAX_RECEIPTS) {
    const prunable = [...byId.values()]
      .filter((row) => isPrunableJournalPhase(row.phase))
      .sort((left, right) => {
        if (left.updatedAtMs !== right.updatedAtMs) {
          return left.updatedAtMs - right.updatedAtMs;
        }
        return left.journalId < right.journalId
          ? -1
          : left.journalId > right.journalId
            ? 1
            : 0;
      });
    const victim = prunable[0];
    if (!victim) {
      throw new Error(
        "File refactor journal at capacity with no prunable terminal receipts"
      );
    }
    byId.delete(victim.journalId);
  }
}

/** In-memory journal port for focused unit tests. */
export function createMemoryFileRefactorJournal(): FileRefactorJournalPort {
  const byId = new Map<string, FileRefactorRecoveryReceipt>();
  return {
    async createPreparedReceipt(draft) {
      pruneOldestTerminalReceipts(byId);
      const receipt: FileRefactorRecoveryReceipt = {
        ...draft,
        phase: "prepared",
        phaseOrdinal: FILE_REFACTOR_JOURNAL_PHASE_ORDINAL.prepared,
        filesystemState: "unchanged",
        indexState: "not_attempted",
        updatedAtMs: draft.createdAtMs,
      };
      byId.set(receipt.journalId, receipt);
      return receipt;
    },
    async advanceReceipt(journalId, update) {
      const current = byId.get(journalId);
      if (!current) throw new Error(`Missing journal ${journalId}`);
      assertAllowedJournalPhaseTransition(current.phase, update.phase);
      if (update.updatedAtMs < current.updatedAtMs) {
        throw new Error("Journal updatedAtMs must be monotonic");
      }
      const next: FileRefactorRecoveryReceipt = {
        ...current,
        phase: update.phase,
        phaseOrdinal: FILE_REFACTOR_JOURNAL_PHASE_ORDINAL[update.phase],
        filesystemState: update.filesystemState ?? current.filesystemState,
        indexState: update.indexState ?? current.indexState,
        fileEntries: update.fileEntries ?? current.fileEntries,
        updatedAtMs: update.updatedAtMs,
      };
      byId.set(journalId, next);
      return next;
    },
    async getReceiptById(journalId) {
      return byId.get(journalId) ?? null;
    },
    async getLatestReceiptByPlanDigest(planDigest) {
      const matches = [...byId.values()].filter(
        (row) => row.planDigest === planDigest
      );
      matches.sort((left, right) => {
        if (left.updatedAtMs !== right.updatedAtMs) {
          return right.updatedAtMs - left.updatedAtMs;
        }
        return right.journalId < left.journalId
          ? -1
          : right.journalId > left.journalId
            ? 1
            : 0;
      });
      return matches[0] ?? null;
    },
  };
}

/** Adapter: wrap StorePort journal methods as FileRefactorJournalPort. */
export function journalPortFromStore(store: {
  createFileRefactorPreparedReceipt: (
    draft: Parameters<FileRefactorJournalPort["createPreparedReceipt"]>[0]
  ) => Promise<
    { ok: true; value: FileRefactorRecoveryReceipt } | { ok: false }
  >;
  advanceFileRefactorReceipt: (
    journalId: string,
    update: Parameters<FileRefactorJournalPort["advanceReceipt"]>[1]
  ) => Promise<
    { ok: true; value: FileRefactorRecoveryReceipt } | { ok: false }
  >;
  getFileRefactorReceiptById: (
    journalId: string
  ) => Promise<
    { ok: true; value: FileRefactorRecoveryReceipt | null } | { ok: false }
  >;
  getLatestFileRefactorReceiptByPlanDigest: (
    planDigest: string
  ) => Promise<
    { ok: true; value: FileRefactorRecoveryReceipt | null } | { ok: false }
  >;
}): FileRefactorJournalPort {
  return {
    async createPreparedReceipt(draft) {
      const result = await store.createFileRefactorPreparedReceipt(draft);
      if (!result.ok) throw new Error("Failed to create refactor receipt");
      return result.value;
    },
    async advanceReceipt(journalId, update) {
      const result = await store.advanceFileRefactorReceipt(journalId, update);
      if (!result.ok) throw new Error("Failed to advance refactor receipt");
      return result.value;
    },
    async getReceiptById(journalId) {
      const result = await store.getFileRefactorReceiptById(journalId);
      if (!result.ok) throw new Error("Failed to load refactor receipt");
      return result.value;
    },
    async getLatestReceiptByPlanDigest(planDigest) {
      const result =
        await store.getLatestFileRefactorReceiptByPlanDigest(planDigest);
      if (!result.ok) throw new Error("Failed to lookup refactor receipt");
      return result.value;
    },
  };
}
