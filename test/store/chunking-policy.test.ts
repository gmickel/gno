import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
// Bun has no temporary-directory creation, OS temp path, or path-join APIs.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StoreResult } from "../../src/store/types";

import { DEFAULT_CHUNKING_PARAMS } from "../../src/config/chunking";
import { migrations, runMigrations } from "../../src/store/migrations";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

const stores: SqliteAdapter[] = [];
const directories: string[] = [];
const chunk = {
  seq: 0,
  pos: 0,
  text: "Legacy evidence",
  startLine: 1,
  endLine: 1,
};

function value<T>(result: StoreResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function fixture(): Promise<{ path: string; store: SqliteAdapter }> {
  const directory = await mkdtemp(join(tmpdir(), "gno-chunk-policy-"));
  directories.push(directory);
  const path = join(directory, "index.sqlite");
  const store = new SqliteAdapter();
  stores.push(store);
  value(await store.open(path, "porter"));
  value(await store.upsertContent("body", "Legacy evidence"));
  value(await store.upsertChunks("body", [chunk]));
  return { path, store };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const directory of directories.splice(0)) await safeRm(directory);
});

test("opening a pre-feature schema preserves schema identity, chunks and legacy vectors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gno-chunk-upgrade-"));
  directories.push(directory);
  const path = join(directory, "index.sqlite");
  const old = new Database(path);
  value(
    runMigrations(
      old,
      migrations.filter((migration) => migration.version < 30),
      "porter"
    )
  );
  old.exec(`INSERT INTO content (mirror_hash, markdown) VALUES ('body', 'Legacy evidence');
    INSERT INTO content_chunks (mirror_hash, seq, pos, text, start_line, end_line, created_at)
      VALUES ('body', 0, 0, 'Legacy evidence', 1, 1, '2020-01-01 00:00:00');
    INSERT INTO content_vectors (mirror_hash, seq, model, embedding, embedded_at)
      VALUES ('body', 0, 'test', X'0000803f', '2020-01-01 00:00:01');`);
  const beforeChunks = old.query("SELECT * FROM content_chunks").all();
  const beforeVectors = old.query("SELECT * FROM content_vectors").all();
  const beforeSchema = old
    .query("SELECT name, sql FROM sqlite_master ORDER BY name")
    .all();
  old.close();

  const store = new SqliteAdapter();
  stores.push(store);
  value(await store.open(path, "porter"));
  expect(
    value(await store.claimChunkingPolicy(DEFAULT_CHUNKING_PARAMS)).generation
  ).toBe(0);
  const db = new Database(path, { readonly: true });
  try {
    expect(db.query("SELECT * FROM content_chunks").all()).toEqual(
      beforeChunks
    );
    expect(db.query("SELECT * FROM content_vectors").all()).toEqual(
      beforeVectors
    );
    expect(
      db.query("SELECT name, sql FROM sqlite_master ORDER BY name").all()
    ).toEqual(beforeSchema);
    expect(
      db
        .query(
          "SELECT value FROM schema_meta WHERE key = 'chunking_mirror_v1:body'"
        )
        .get()
    ).toBeNull();
    expect(
      db
        .query("SELECT value FROM schema_meta WHERE key = 'chunking_policy_v1'")
        .get()
    ).toBeNull();
  } finally {
    db.close();
  }
});

test("stale stores cannot claim or write a newer target, including a revert", async () => {
  const { path, store } = await fixture();
  const stale = new SqliteAdapter();
  stores.push(stale);
  value(await stale.open(path, "porter"));
  const prior = value(await stale.claimChunkingPolicy(DEFAULT_CHUNKING_PARAMS));
  const custom = value(
    await store.claimChunkingPolicy({ maxTokens: 64, overlapPercent: 0 })
  );
  expect(custom.generation).toBe(1);
  const conflict = await stale.claimChunkingPolicy(DEFAULT_CHUNKING_PARAMS);
  expect(conflict.ok).toBe(false);
  if (!conflict.ok)
    expect(conflict.error.code).toBe("CHUNKING_POLICY_CONFLICT");
  expect(
    (await stale.applyChunkLayout("body", [chunk], prior, "note.md")).ok
  ).toBe(false);
  expect((await stale.upsertChunks("body", [chunk])).ok).toBe(false);
  const reverted = value(
    await store.claimChunkingPolicy(DEFAULT_CHUNKING_PARAMS)
  );
  expect(reverted.generation).toBe(2);
  expect(
    (await stale.applyChunkLayout("body", [chunk], prior, "note.md")).ok
  ).toBe(false);
  await stale.close();
  value(await stale.open(path, "porter"));
  expect(
    value(await stale.claimChunkingPolicy(DEFAULT_CHUNKING_PARAMS)).generation
  ).toBe(2);
});

test("failed lexical application rolls back chunks, policy and vectors together", async () => {
  const { path, store } = await fixture();
  const db = new Database(path);
  try {
    db.exec(`INSERT INTO content_vectors (mirror_hash, seq, model, embedding)
      VALUES ('body', 0, 'test', X'0000803f');`);
    const beforeChunks = db.query("SELECT * FROM content_chunks").all();
    const beforeVectors = db.query("SELECT * FROM content_vectors").all();
    const token = value(
      await store.claimChunkingPolicy({ maxTokens: 64, overlapPercent: 0 })
    );
    const original = store.rebuildFtsForHash.bind(store);
    store.rebuildFtsForHash = () =>
      Promise.resolve({
        ok: false,
        error: { code: "QUERY_FAILED", message: "injected FTS failure" },
      });
    const result = await store.applyChunkLayout(
      "body",
      [{ ...chunk, text: "Changed evidence" }],
      token,
      "note.md"
    );
    expect(result.ok).toBe(false);
    expect(db.query("SELECT * FROM content_chunks").all()).toEqual(
      beforeChunks
    );
    expect(db.query("SELECT * FROM content_vectors").all()).toEqual(
      beforeVectors
    );
    expect(
      db
        .query(
          "SELECT value FROM schema_meta WHERE key = 'chunking_mirror_v1:body'"
        )
        .get()
    ).toBeNull();
    store.rebuildFtsForHash = original;
    value(
      await store.applyChunkLayout(
        "body",
        [{ ...chunk, text: "Changed evidence" }],
        token,
        "note.md"
      )
    );
    expect(db.query("SELECT COUNT(*) AS n FROM content_vectors").get()).toEqual(
      { n: 0 }
    );
    expect(
      db
        .query(
          "SELECT json_extract(value, '$.sourcePath') AS source_path FROM schema_meta WHERE key = 'chunking_mirror_v1:body'"
        )
        .get()
    ).toEqual({ source_path: "note.md" });
  } finally {
    db.close();
  }
});

test("identical layout application preserves vector bytes and chunk timestamps", async () => {
  const { path, store } = await fixture();
  const db = new Database(path);
  try {
    db.exec(`INSERT INTO content_vectors (mirror_hash, seq, model, embedding)
      VALUES ('body', 0, 'test', X'0000803f');`);
    const beforeChunks = db.query("SELECT * FROM content_chunks").all();
    const beforeVectors = db.query("SELECT * FROM content_vectors").all();
    const token = value(
      await store.claimChunkingPolicy(DEFAULT_CHUNKING_PARAMS)
    );
    value(
      await store.applyChunkLayout("body", [chunk], token, "note.md", "en")
    );
    value(
      await store.applyChunkLayout("body", [chunk], token, "note.md", "en")
    );
    expect(db.query("SELECT * FROM content_chunks").all()).toEqual(
      beforeChunks
    );
    expect(db.query("SELECT * FROM content_vectors").all()).toEqual(
      beforeVectors
    );
  } finally {
    db.close();
  }
});

test("an empty missing mirror cannot be marked successfully applied", async () => {
  const { store } = await fixture();
  const token = value(await store.claimChunkingPolicy(DEFAULT_CHUNKING_PARAMS));
  expect(
    (await store.applyChunkLayout("missing", [], token, "empty.md")).ok
  ).toBe(false);
});

test("orphan cleanup removes mirror metadata and retains the index target", async () => {
  const { store } = await fixture();
  const token = value(
    await store.claimChunkingPolicy({ maxTokens: 64, overlapPercent: 0 })
  );
  value(await store.applyChunkLayout("body", [chunk], token, "note.md"));
  value(await store.cleanupOrphans());
  expect(
    store
      .getRawDb()
      .query(
        "SELECT value FROM schema_meta WHERE key = 'chunking_mirror_v1:body'"
      )
      .get()
  ).toBeNull();
  expect(
    store
      .getRawDb()
      .query("SELECT value FROM schema_meta WHERE key = 'chunking_policy_v1'")
      .get()
  ).not.toBeNull();
});
