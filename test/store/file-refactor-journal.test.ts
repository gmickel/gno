/**
 * Store tests for content-free file-refactor recovery journal.
 *
 * @module test/store/file-refactor-journal
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import {
  FILE_REFACTOR_JOURNAL_MAX_RECEIPTS,
  parseFileRefactorJournalFileEntries,
} from "../../src/core/file-refactor-journal";
import { migrations, runMigrations } from "../../src/store";
import {
  advanceFileRefactorReceipt,
  createFileRefactorPreparedReceipt,
  getFileRefactorReceiptById,
  getLatestFileRefactorReceiptByPlanDigest,
} from "../../src/store/sqlite/file-refactor-journal-store";

const dbs: Database[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.close();
  }
});

function openMigrated(): Database {
  const db = new Database(":memory:");
  dbs.push(db);
  const result = runMigrations(db, migrations, "unicode61");
  expect(result.ok).toBe(true);
  return db;
}

function draft(id: string, digest: string, createdAtMs: number) {
  return {
    journalId: id,
    planDigest: digest,
    collection: "notes",
    operation: "rename" as const,
    sourceRelPath: "old.md",
    targetRelPath: "new.md",
    fileEntries: [
      {
        role: "source" as const,
        relPath: "old.md",
        stageRelPath: "new.md.gno-rf-stage.x",
        backupRelPath: "old.md.gno-rf-backup.x",
        originalFingerprint: "b".repeat(64),
        expectedFingerprint: "c".repeat(64),
        status: "pending" as const,
      },
    ],
    createdAtMs,
  };
}

describe("file_refactor_recovery_journal", () => {
  test("migration creates table and store helpers round-trip content-free receipts", () => {
    const db = openMigrated();
    const tables = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='file_refactor_recovery_journal'`
      )
      .all();
    expect(tables).toHaveLength(1);

    const digest = "a".repeat(64);
    const created = createFileRefactorPreparedReceipt(
      db,
      draft("jr-1", digest, 100)
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.phase).toBe("prepared");
    expect(JSON.stringify(created.value)).not.toContain("body");

    expect(
      advanceFileRefactorReceipt(db, "jr-1", {
        phase: "staging",
        updatedAtMs: 150,
      }).ok
    ).toBe(true);
    expect(
      advanceFileRefactorReceipt(db, "jr-1", {
        phase: "committing",
        updatedAtMs: 160,
      }).ok
    ).toBe(true);
    expect(
      advanceFileRefactorReceipt(db, "jr-1", {
        phase: "committed",
        filesystemState: "committed",
        updatedAtMs: 170,
      }).ok
    ).toBe(true);
    const advanced = advanceFileRefactorReceipt(db, "jr-1", {
      phase: "sync_pending",
      filesystemState: "committed",
      indexState: "pending",
      updatedAtMs: 200,
    });
    expect(advanced.ok).toBe(true);

    const byId = getFileRefactorReceiptById(db, "jr-1");
    expect(byId.ok && byId.value?.phase).toBe("sync_pending");

    createFileRefactorPreparedReceipt(db, draft("jr-2", digest, 300));
    const latest = getLatestFileRefactorReceiptByPlanDigest(db, digest);
    expect(latest.ok && latest.value?.journalId).toBe("jr-2");
  });

  test("rejects invalid phase regression and non-monotonic updatedAt", () => {
    const db = openMigrated();
    const digest = "d".repeat(64);
    expect(
      createFileRefactorPreparedReceipt(db, draft("jr-a", digest, 1)).ok
    ).toBe(true);
    expect(
      advanceFileRefactorReceipt(db, "jr-a", {
        phase: "staging",
        updatedAtMs: 2,
      }).ok
    ).toBe(true);
    expect(
      advanceFileRefactorReceipt(db, "jr-a", {
        phase: "committing",
        updatedAtMs: 3,
      }).ok
    ).toBe(true);
    expect(
      advanceFileRefactorReceipt(db, "jr-a", {
        phase: "committed",
        filesystemState: "committed",
        updatedAtMs: 4,
      }).ok
    ).toBe(true);
    expect(
      advanceFileRefactorReceipt(db, "jr-a", {
        phase: "converged",
        filesystemState: "committed",
        indexState: "converged",
        updatedAtMs: 5,
      }).ok
    ).toBe(true);
    const regress = advanceFileRefactorReceipt(db, "jr-a", {
      phase: "staging",
      updatedAtMs: 6,
    });
    expect(regress.ok).toBe(false);

    expect(
      createFileRefactorPreparedReceipt(db, draft("jr-b", digest, 10)).ok
    ).toBe(true);
    const nonMono = advanceFileRefactorReceipt(db, "jr-b", {
      phase: "staging",
      updatedAtMs: 5,
    });
    expect(nonMono.ok).toBe(false);
  });

  test("rejects corrupt file_entries_json shapes", () => {
    expect(() => parseFileRefactorJournalFileEntries("{")).toThrow();
    expect(() => parseFileRefactorJournalFileEntries([])).not.toThrow();
    expect(() =>
      parseFileRefactorJournalFileEntries([{ role: "source" }])
    ).toThrow();
    expect(() =>
      parseFileRefactorJournalFileEntries([
        {
          role: "source",
          relPath: "a.md",
          status: "pending",
          body: "secret",
        },
      ])
    ).toThrow();
    expect(() =>
      parseFileRefactorJournalFileEntries([
        {
          role: "source",
          relPath: "a.md",
          status: "pending",
          originalFingerprint: "not-hex",
        },
      ])
    ).toThrow();
    expect(() =>
      parseFileRefactorJournalFileEntries([
        {
          role: "source",
          relPath: "a.md",
          status: "pending",
          stageRelPath: "../../etc/passwd.gno-rf-stage.x",
        },
      ])
    ).toThrow();
    expect(() =>
      parseFileRefactorJournalFileEntries([
        {
          role: "source",
          relPath: "a.md",
          status: "pending",
        },
        {
          role: "affected",
          relPath: "a.md",
          status: "pending",
        },
      ])
    ).toThrow();
  });

  test("prunes oldest terminal receipts at hard cap and never recovery_required", () => {
    const db = openMigrated();
    const digest = "e".repeat(64);
    for (let i = 0; i < FILE_REFACTOR_JOURNAL_MAX_RECEIPTS - 1; i++) {
      const id = `term-${i}`;
      expect(
        createFileRefactorPreparedReceipt(db, draft(id, digest, i)).ok
      ).toBe(true);
      for (const step of [
        ["staging", i + 0.1],
        ["committing", i + 0.2],
        ["committed", i + 0.3],
        ["converged", i + 0.4],
      ] as const) {
        const phase = step[0];
        expect(
          advanceFileRefactorReceipt(db, id, {
            phase,
            filesystemState:
              phase === "committed" || phase === "converged"
                ? "committed"
                : undefined,
            indexState: phase === "converged" ? "converged" : undefined,
            updatedAtMs: Math.floor(step[1] * 1000),
          }).ok
        ).toBe(true);
      }
    }

    expect(
      createFileRefactorPreparedReceipt(
        db,
        draft("recovery-keep", digest, 50_000)
      ).ok
    ).toBe(true);
    expect(
      advanceFileRefactorReceipt(db, "recovery-keep", {
        phase: "staging",
        updatedAtMs: 50_001,
      }).ok
    ).toBe(true);
    expect(
      advanceFileRefactorReceipt(db, "recovery-keep", {
        phase: "recovery_required",
        filesystemState: "recovery_required",
        updatedAtMs: 50_002,
      }).ok
    ).toBe(true);

    const created = createFileRefactorPreparedReceipt(
      db,
      draft("overflow", digest, 60_000)
    );
    expect(created.ok).toBe(true);

    const count = db
      .query<{ count: number }, []>(
        `SELECT COUNT(*) AS count FROM file_refactor_recovery_journal`
      )
      .get()?.count;
    expect(count).toBeLessThanOrEqual(FILE_REFACTOR_JOURNAL_MAX_RECEIPTS);

    const recovery = getFileRefactorReceiptById(db, "recovery-keep");
    expect(recovery.ok && recovery.value?.phase).toBe("recovery_required");

    const oldest = getFileRefactorReceiptById(db, "term-0");
    expect(oldest.ok && oldest.value).toBeNull();
  });
});
