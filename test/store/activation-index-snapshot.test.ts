import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ActivationIndexSnapshot } from "../../src/store/types";

import { fingerprintActivationIndex } from "../../src/core/activation-probe";
import { SqliteAdapter } from "../../src/store";
import { safeRm } from "../helpers/cleanup";

function hash(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function fingerprint(snapshot: ActivationIndexSnapshot): string {
  return fingerprintActivationIndex({
    collection: "notes",
    indexName: snapshot.identity.indexName,
    schemaVersion: snapshot.identity.schemaVersion,
    ftsTokenizer: snapshot.identity.ftsTokenizer,
    ftsStateHash: snapshot.identity.ftsStateHash,
    documents: snapshot.documents,
  });
}

describe("activation index snapshot", () => {
  let adapter: SqliteAdapter;
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "gno-activation-snapshot-test-"));
    adapter = new SqliteAdapter();
    expect(
      (await adapter.open(join(testDir, "index-test.sqlite"), "unicode61")).ok
    ).toBe(true);
    expect(
      (
        await adapter.syncCollections([
          {
            name: "notes",
            path: "/notes",
            pattern: "**/*",
            include: [],
            exclude: [],
          },
        ])
      ).ok
    ).toBe(true);
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(testDir);
  });

  async function upsertDocument(
    body: string,
    options: { persistContent?: boolean } = {}
  ): Promise<string> {
    const mirrorHash = hash(`mirror:${body}`);
    expect(
      (
        await adapter.upsertDocument({
          collection: "notes",
          relPath: "tracked.md",
          title: "Tracked",
          sourceHash: hash(`source:${body}`),
          mirrorHash,
          sourceMime: "text/markdown",
          sourceExt: ".md",
          sourceSize: body.length,
          sourceMtime: "2026-07-22T10:00:00.000Z",
        })
      ).ok
    ).toBe(true);
    if (options.persistContent !== false) {
      expect((await adapter.upsertContent(mirrorHash, body)).ok).toBe(true);
    }
    return mirrorHash;
  }

  test("known boundary: out-of-band FTS body mutation is metadata-invisible", async () => {
    await upsertDocument("original evidence");
    expect((await adapter.syncDocumentFts("notes", "tracked.md")).ok).toBe(
      true
    );
    const before = await adapter.getActivationIndexSnapshot("notes");
    expect(before.ok).toBe(true);
    if (!before.ok) {
      return;
    }

    adapter.getRawDb().run(
      `UPDATE documents_fts SET body = 'tampered evidence'
       WHERE rowid = (SELECT id FROM documents WHERE rel_path = 'tracked.md')`
    );

    const after = await adapter.getActivationIndexSnapshot("notes");
    expect(after.ok).toBe(true);
    if (!after.ok) {
      return;
    }
    expect(after.value.identity.ftsSynchronized).toBe(true);
    expect(after.value.identity.ftsStateHash).toBe(
      before.value.identity.ftsStateHash
    );
    expect(fingerprint(after.value)).toBe(fingerprint(before.value));
  });

  test("supported rewrites replace markers and no-content sync clears them", async () => {
    const firstMirror = await upsertDocument("first evidence");
    expect((await adapter.syncDocumentFts("notes", "tracked.md")).ok).toBe(
      true
    );
    expect(
      adapter
        .getRawDb()
        .query<{ fts_mirror_hash: string | null }, []>(
          "SELECT fts_mirror_hash FROM documents WHERE rel_path = 'tracked.md'"
        )
        .get()?.fts_mirror_hash
    ).toBe(firstMirror);

    const secondMirror = await upsertDocument("second evidence");
    expect((await adapter.syncDocumentFts("notes", "tracked.md")).ok).toBe(
      true
    );
    expect(
      adapter
        .getRawDb()
        .query<{ fts_mirror_hash: string | null }, []>(
          "SELECT fts_mirror_hash FROM documents WHERE rel_path = 'tracked.md'"
        )
        .get()?.fts_mirror_hash
    ).toBe(secondMirror);

    await upsertDocument("content intentionally absent", {
      persistContent: false,
    });
    expect((await adapter.syncDocumentFts("notes", "tracked.md")).ok).toBe(
      true
    );
    const row = adapter
      .getRawDb()
      .query<{ fts_mirror_hash: string | null; fts_rows: number }, []>(
        `SELECT d.fts_mirror_hash,
                (SELECT COUNT(*) FROM documents_fts f WHERE f.rowid = d.id) AS fts_rows
         FROM documents d WHERE d.rel_path = 'tracked.md'`
      )
      .get();
    expect(row).toEqual({ fts_mirror_hash: null, fts_rows: 0 });

    const snapshot = await adapter.getActivationIndexSnapshot("notes");
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.value.identity.ftsSynchronized).toBe(false);
    }
  });

  test("dropping mirror ownership atomically clears stale lexical content", async () => {
    await upsertDocument("obsolete lexical evidence");
    expect((await adapter.syncDocumentFts("notes", "tracked.md")).ok).toBe(
      true
    );
    const indexed = await adapter.searchFts("obsolete", {
      collection: "notes",
    });
    expect(indexed.ok && indexed.value).toHaveLength(1);

    expect(
      (
        await adapter.upsertDocument({
          collection: "notes",
          relPath: "tracked.md",
          sourceHash: hash("source:conversion-failed"),
          sourceMime: "application/pdf",
          sourceExt: ".pdf",
          sourceSize: 128,
          sourceMtime: "2026-07-22T11:00:00.000Z",
          lastErrorCode: "CONVERSION_FAILED",
          lastErrorMessage: "Invalid document structure",
        })
      ).ok
    ).toBe(true);

    const staleSearch = await adapter.searchFts("obsolete", {
      collection: "notes",
    });
    expect(staleSearch.ok && staleSearch.value).toHaveLength(0);

    const row = adapter
      .getRawDb()
      .query<{ fts_mirror_hash: string | null; fts_rows: number }, []>(
        `SELECT d.fts_mirror_hash,
                (SELECT COUNT(*) FROM documents_fts f WHERE f.rowid = d.id) AS fts_rows
         FROM documents d WHERE d.rel_path = 'tracked.md'`
      )
      .get();
    expect(row).toEqual({ fts_mirror_hash: null, fts_rows: 0 });

    const snapshot = await adapter.getActivationIndexSnapshot("notes");
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.value.identity.ftsSynchronized).toBe(true);
      expect(snapshot.value.documents).toEqual([
        expect.objectContaining({
          mirrorHash: null,
        }),
      ]);
    }
  });
});
