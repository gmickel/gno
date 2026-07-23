import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises only supplies temporary-directory structure operations.
import { mkdtemp } from "node:fs/promises";
// node:os/node:path have no Bun utility equivalents.
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getSchemaVersion, migrations, runMigrations } from "../../src/store";
import { safeRm } from "../helpers/cleanup";

const TRACE_TABLES = [
  "retrieval_trace_events",
  "retrieval_trace_export_traces",
  "retrieval_trace_exports",
  "retrieval_trace_judgments",
  "retrieval_trace_runs",
  "retrieval_traces",
];

const TRACE_TRIGGERS = [
  "cap_retrieval_trace_events",
  "cap_retrieval_trace_export_links",
  "cap_retrieval_trace_judgments",
  "cap_retrieval_trace_runs",
  "delete_empty_retrieval_trace_export",
];

const schemaObjects = (db: Database, type: "table" | "trigger"): string[] =>
  db
    .query<{ name: string }, [string, string]>(
      `SELECT name FROM sqlite_master
       WHERE type = ? AND name LIKE ? ORDER BY name`
    )
    .all(type, type === "table" ? "retrieval_trace%" : "%retrieval_trace%")
    .map(({ name }) => name);

describe("retrieval trace migration compatibility", () => {
  let root = "";
  let dbPath = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gno-trace-migration-"));
    dbPath = join(root, "index.sqlite");
  });

  afterEach(async () => {
    await safeRm(root);
  });

  for (const baseline of [12, 13]) {
    test(`upgrades v${baseline} to v14 with closed trace ownership`, () => {
      const db = new Database(dbPath);
      try {
        db.run("PRAGMA foreign_keys = ON");
        expect(
          runMigrations(db, migrations.slice(0, baseline), "unicode61").ok
        ).toBeTrue();
        expect(getSchemaVersion(db)).toBe(baseline);

        const upgraded = runMigrations(
          db,
          migrations.slice(0, 14),
          "unicode61"
        );
        expect(upgraded.ok).toBeTrue();
        if (!upgraded.ok) return;
        expect(upgraded.value.applied).toEqual(
          baseline === 12 ? [13, 14] : [14]
        );
        expect(getSchemaVersion(db)).toBe(14);
        expect(schemaObjects(db, "table")).toEqual(TRACE_TABLES);
        expect(schemaObjects(db, "trigger")).toEqual(TRACE_TRIGGERS);

        const eventForeignKeys = db
          .query<{ table: string }, []>(
            "PRAGMA foreign_key_list(retrieval_trace_events)"
          )
          .all()
          .map(({ table }) => table)
          .sort();
        expect(eventForeignKeys).toEqual([
          "retrieval_trace_runs",
          "retrieval_trace_runs",
          "retrieval_traces",
        ]);
        expect(
          db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()
            ?.foreign_keys
        ).toBe(1);
      } finally {
        db.close();
      }
    });
  }

  test("rolls a failed v14 upgrade back without partial trace objects", () => {
    const db = new Database(dbPath);
    try {
      expect(
        runMigrations(db, migrations.slice(0, 13), "unicode61").ok
      ).toBeTrue();
      db.exec(`
        CREATE TRIGGER cap_retrieval_trace_export_links
        BEFORE INSERT ON documents
        BEGIN
          SELECT 1;
        END
      `);

      const failed = runMigrations(db, migrations.slice(0, 14), "unicode61");
      expect(failed.ok).toBeFalse();
      expect(getSchemaVersion(db)).toBe(13);
      expect(schemaObjects(db, "table")).toEqual([]);
      expect(schemaObjects(db, "trigger")).toEqual([
        "cap_retrieval_trace_export_links",
      ]);
      expect(
        db
          .query<{ name: string }, []>(
            `SELECT name FROM sqlite_master
             WHERE type = 'index' AND name LIKE 'idx_retrieval_trace%'`
          )
          .all()
      ).toEqual([]);
      expect(
        db
          .query<{ tableName: string }, []>(
            `SELECT tbl_name AS tableName FROM sqlite_master
             WHERE type = 'trigger'
               AND name = 'cap_retrieval_trace_export_links'`
          )
          .get()
      ).toEqual({ tableName: "documents" });
    } finally {
      db.close();
    }
  });

  test("migration rollback hook removes every v14 trace object", () => {
    const db = new Database(dbPath);
    try {
      expect(
        runMigrations(db, migrations.slice(0, 14), "unicode61").ok
      ).toBeTrue();
      const traceMigration = migrations.find(({ version }) => version === 14);
      expect(typeof traceMigration?.down).toBe("function");
      traceMigration?.down?.(db);
      expect(schemaObjects(db, "table")).toEqual([]);
      expect(schemaObjects(db, "trigger")).toEqual([]);
      expect(
        db
          .query<{ name: string }, []>(
            `SELECT name FROM sqlite_master
             WHERE name LIKE 'idx_retrieval_trace%'`
          )
          .all()
      ).toEqual([]);
      expect(
        db.query<Record<string, unknown>, []>("PRAGMA foreign_key_check").all()
      ).toEqual([]);
    } finally {
      db.close();
    }
  });
});
