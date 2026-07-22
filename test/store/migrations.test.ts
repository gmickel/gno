import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyLexicalActivation } from "../../src/core/activation-verifier";
import { getSchemaVersion, migrations, runMigrations } from "../../src/store";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
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
      expect(getSchemaVersion(db)).toBe(13);

      const indexedRow = db
        .query<{ indexed_at: string | null }, []>(
          "SELECT indexed_at FROM documents WHERE collection = 'notes' AND rel_path = 'legacy.md'"
        )
        .get();
      expect(indexedRow).toBeDefined();
      expect(indexedRow?.indexed_at).not.toBeNull();

      const vectorColumns = db
        .query<{ name: string }, []>("PRAGMA table_info(content_vectors)")
        .all()
        .map((column) => column.name);
      expect(vectorColumns).toContain("embed_fingerprint");

      const activationColumns = db
        .query<{ name: string }, []>("PRAGMA table_info(activation_receipts)")
        .all()
        .map((column) => column.name);
      expect(activationColumns).toEqual([
        "collection",
        "connector_target",
        "schema_version",
        "fingerprint",
        "receipt_json",
        "updated_at",
      ]);

      const documentColumns = db
        .query<{ name: string }, []>("PRAGMA table_info(documents)")
        .all()
        .map((column) => column.name);
      expect(documentColumns).toContain("fts_mirror_hash");
    } finally {
      db.close();
    }
  });

  test("backfills FTS sync markers only for fully aligned active legacy rows", () => {
    const db = new Database(dbPath);

    try {
      expect(runMigrations(db, migrations.slice(0, 12), "unicode61").ok).toBe(
        true
      );
      db.exec(`
        INSERT INTO collections (name, path, pattern)
        VALUES ('notes', '/notes', '**/*');
        INSERT INTO content (mirror_hash, markdown)
        VALUES
          ('mirror-current', 'current body'),
          ('mirror-filepath', 'filepath body'),
          ('mirror-title', 'title body'),
          ('mirror-inactive', 'inactive body'),
          ('mirror-body', 'expected body');
        INSERT INTO documents (
          collection, rel_path, source_hash, source_mime, source_ext,
          source_size, source_mtime, docid, uri, title, mirror_hash, active
        ) VALUES
          ('notes', 'current.md', 'source-current', 'text/markdown', '.md',
           12, '2026-07-22T10:00:00.000Z', 'current1', 'gno://notes/current.md',
           'Current', 'mirror-current', 1),
          ('notes', 'filepath.md', 'source-filepath', 'text/markdown', '.md',
           13, '2026-07-22T10:00:00.000Z', 'filepath1', 'gno://notes/filepath.md',
           'Filepath', 'mirror-filepath', 1),
          ('notes', 'title.md', 'source-title', 'text/markdown', '.md',
           10, '2026-07-22T10:00:00.000Z', 'title001', 'gno://notes/title.md',
           'Title', 'mirror-title', 1),
          ('notes', 'inactive.md', 'source-inactive', 'text/markdown', '.md',
           13, '2026-07-22T10:00:00.000Z', 'inactive1', 'gno://notes/inactive.md',
           'Inactive', 'mirror-inactive', 0),
          ('notes', 'body.md', 'source-body', 'text/markdown', '.md',
           13, '2026-07-22T10:00:00.000Z', 'body0001', 'gno://notes/body.md',
           'Body', 'mirror-body', 1);
        INSERT INTO documents_fts (rowid, filepath, title, body)
        SELECT id, rel_path, title, 'current body'
        FROM documents WHERE rel_path = 'current.md';
        INSERT INTO documents_fts (rowid, filepath, title, body)
        SELECT id, 'wrong-path.md', title, 'filepath body'
        FROM documents WHERE rel_path = 'filepath.md';
        INSERT INTO documents_fts (rowid, filepath, title, body)
        SELECT id, rel_path, 'Wrong title', 'title body'
        FROM documents WHERE rel_path = 'title.md';
        INSERT INTO documents_fts (rowid, filepath, title, body)
        SELECT id, rel_path, title, 'inactive body'
        FROM documents WHERE rel_path = 'inactive.md';
        INSERT INTO documents_fts (rowid, filepath, title, body)
        SELECT id, rel_path, title, 'stale body'
        FROM documents WHERE rel_path = 'body.md';
      `);

      const upgraded = runMigrations(db, migrations, "unicode61");
      expect(upgraded.ok).toBe(true);
      expect(getSchemaVersion(db)).toBe(13);
      const rows = db
        .query<{ rel_path: string; fts_mirror_hash: string | null }, []>(
          "SELECT rel_path, fts_mirror_hash FROM documents ORDER BY rel_path"
        )
        .all();
      expect(rows).toEqual([
        { rel_path: "body.md", fts_mirror_hash: null },
        { rel_path: "current.md", fts_mirror_hash: "mirror-current" },
        { rel_path: "filepath.md", fts_mirror_hash: null },
        { rel_path: "inactive.md", fts_mirror_hash: null },
        { rel_path: "title.md", fts_mirror_hash: null },
      ]);
    } finally {
      db.close();
    }
  });

  test("leaves stale legacy FTS bodies unsynchronized until rebuilt", async () => {
    const db = new Database(dbPath);
    try {
      expect(runMigrations(db, migrations.slice(0, 12), "unicode61").ok).toBe(
        true
      );
      db.exec(`
        INSERT INTO collections (name, path, pattern)
        VALUES ('notes', '/notes', '**/*');
        INSERT INTO content (mirror_hash, markdown)
        VALUES ('mirror-new', 'shared beta evidence');
        INSERT INTO documents (
          collection, rel_path, source_hash, source_mime, source_ext,
          source_size, source_mtime, docid, uri, title, mirror_hash, active
        ) VALUES (
          'notes', 'stale.md',
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'text/markdown', '.md', 20,
          '2026-07-22T10:00:00.000Z', 'stale001', 'gno://notes/stale.md',
          'Stale', 'mirror-new', 1
        );
        INSERT INTO documents_fts (rowid, filepath, title, body)
        SELECT id, rel_path, title, 'shared alpha evidence'
        FROM documents WHERE rel_path = 'stale.md';
      `);

      expect(runMigrations(db, migrations, "unicode61").ok).toBe(true);
      expect(
        db
          .query<{ fts_mirror_hash: string | null }, []>(
            "SELECT fts_mirror_hash FROM documents WHERE rel_path = 'stale.md'"
          )
          .get()?.fts_mirror_hash
      ).toBeNull();
    } finally {
      db.close();
    }

    const adapter = new SqliteAdapter();
    try {
      expect((await adapter.open(dbPath, "unicode61")).ok).toBe(true);
      const stale = await verifyLexicalActivation(adapter, "notes");
      expect(stale.ok).toBe(true);
      if (stale.ok) {
        expect(stale.value.stages.index.code).toBe("index_out_of_sync");
      }

      expect((await adapter.rebuildAllDocumentsFts()).ok).toBe(true);
      const rebuilt = await verifyLexicalActivation(adapter, "notes");
      expect(rebuilt.ok && rebuilt.value.ready).toBe(true);
    } finally {
      await adapter.close();
    }
  });
});
