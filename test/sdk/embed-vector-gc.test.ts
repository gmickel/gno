/**
 * SDK embedding takes no write lease, so its automatic vector GC (gno#361)
 * deletes only while the shared index write lease is free: another holder
 * defers it, a later pass collects.
 */
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
// Bun has no temporary-directory creation or path API.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../../src/config/types";
import type { LlmAdapter } from "../../src/llm/nodeLlamaCpp/adapter";
import type { EmbeddingPort } from "../../src/llm/types";
import type { SqliteAdapter } from "../../src/store/sqlite/adapter";

import { CONFIG_VERSION } from "../../src/config/types";
import { acquireCliWriteLease } from "../../src/core/write-lease";
import { runEmbed } from "../../src/sdk/embed";
import { migration as variantsMigration } from "../../src/store/migrations/028-vector-variants";
import { migration as runtimeMigration } from "../../src/store/migrations/031-runtime-independent-vectors";
import { migration as mirrorMigration } from "../../src/store/migrations/036-vector-mirror-state";
import { migration as gcMigration } from "../../src/store/migrations/040-vector-gc-candidates";
import { AUTO_VECTOR_GC_GRACE_SECONDS } from "../../src/store/vector/garbage";
import { safeRm } from "../helpers/cleanup";

const MODEL_URI = "hf:test/model.gguf";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("SDK automatic vector GC waits for a free write lease", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gno-sdk-vector-gc-"));
  cleanups.push(() => safeRm(dir));
  const dbPath = join(dir, "index.sqlite");
  const db = new Database(dbPath, { create: true });
  cleanups.push(async () => db.close());
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE documents(id INTEGER PRIMARY KEY, mirror_hash TEXT, title TEXT,
      collection TEXT, active INTEGER DEFAULT 1, updated_at TEXT);
    CREATE TABLE content_chunks(mirror_hash TEXT NOT NULL, seq INTEGER NOT NULL,
      text TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (mirror_hash, seq));
    CREATE TABLE content_vectors(mirror_hash TEXT NOT NULL, seq INTEGER NOT NULL,
      model TEXT NOT NULL, embed_fingerprint TEXT NOT NULL DEFAULT '', embedding BLOB NOT NULL,
      embedded_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (mirror_hash, seq, model));
    INSERT INTO documents(id, mirror_hash, title, active) VALUES (1, 'h1', 'One', 1), (2, 'h2', 'Two', 1);
    INSERT INTO content_chunks(mirror_hash, seq, text) VALUES ('h1', 0, 'first'), ('h2', 0, 'second');`);
  for (const m of [
    variantsMigration,
    runtimeMigration,
    mirrorMigration,
    gcMigration,
  ])
    m.up(db, "unicode61");

  const embedPort: EmbeddingPort = {
    modelUri: MODEL_URI,
    init: async () => ({ ok: true, value: undefined }),
    embed: async () => ({ ok: true, value: [1, 2, 3] }),
    embedBatch: async (texts) => ({
      ok: true,
      value: texts.map(() => [1, 2, 3]),
    }),
    dimensions: () => 3,
    getIdentity: () => ({
      contextSize: 512,
      truncationPolicy: "test",
      modelFingerprint: "weights",
      runtimeFingerprint: "runtime",
    }),
    dispose: async () => {},
  };
  const runtime = {
    config: {
      version: CONFIG_VERSION,
      ftsTokenizer: "unicode61",
      collections: [],
      contexts: [],
    } as Config,
    store: { getRawDb: () => db } as unknown as SqliteAdapter,
    llm: {
      createEmbeddingPort: async () => ({ ok: true, value: embedPort }),
    } as unknown as LlmAdapter,
  };
  const variants = () =>
    db
      .query<{ n: number }, []>("SELECT count(*) AS n FROM vector_variants")
      .get()!.n;

  expect((await runEmbed(runtime, { model: MODEL_URI })).embedded).toBe(2);
  db.run("UPDATE documents SET active = 0 WHERE id = 2");
  db.run("UPDATE vector_gc_candidates SET queued_at = queued_at - ?", [
    AUTO_VECTOR_GC_GRACE_SECONDS + 1,
  ]);

  // Another writer holds the lease: GC is deferred, nothing is deleted.
  const held = await acquireCliWriteLease({ dbPath, waitMs: 0, noWait: true });
  if (!held.ok) throw new Error("lease unexpectedly busy");
  await runEmbed(runtime, { model: MODEL_URI });
  expect(variants()).toBe(2);
  await held.release();

  // Free again: the next pass collects.
  await runEmbed(runtime, { model: MODEL_URI });
  expect(variants()).toBe(1);
  expect(
    db.query("SELECT count(*) AS n FROM vector_gc_candidates").get()
  ).toEqual({ n: 0 });
});
