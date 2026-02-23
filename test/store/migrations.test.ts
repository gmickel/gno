import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getSchemaVersion, migrations, runMigrations } from "../../src/store";
import { safeRm } from "../helpers/cleanup";

describe("store migrations", () => {
  let testDir = "";
  let dbPath = "";

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "gno-migrations-test-"));
    dbPath = join(testDir, "test.sqlite");
  });

  afterEach(async () => {
    await safeRm(testDir);
  });

  test("upgrades v5 databases without non-constant ALTER TABLE defaults", () => {
    const db = new Database(dbPath);

    try {
      const v5Result = runMigrations(db, migrations.slice(0, 5), "unicode61");
      expect(v5Result.ok).toBe(true);

      db.exec(`
        INSERT INTO collections (name, path, pattern)
        VALUES ('notes', '/notes', '**/*')
      `);
      db.exec(`
        INSERT INTO documents (
          collection, rel_path, source_hash, source_mime, source_ext,
          source_size, source_mtime, docid, uri, active, ingest_version
        ) VALUES (
          'notes',
          'legacy.md',
          'abc123',
          'text/markdown',
          '.md',
          100,
          '2026-02-20T12:00:00.000Z',
          'doc-legacy',
          'notes://legacy.md',
          1,
          1
        )
      `);

      const upgradeResult = runMigrations(db, migrations, "unicode61");
      expect(upgradeResult.ok).toBe(true);
      expect(getSchemaVersion(db)).toBe(7);

      const indexedRow = db
        .query<{ indexed_at: string | null }, []>(
          "SELECT indexed_at FROM documents WHERE collection = 'notes' AND rel_path = 'legacy.md'"
        )
        .get();
      expect(indexedRow).toBeDefined();
      expect(indexedRow?.indexed_at).not.toBeNull();
    } finally {
      db.close();
    }
  });
});
