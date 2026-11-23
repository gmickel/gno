/**
 * Automatic vector GC at the end of an embed pass (gno#361): it removes
 * exactly the variants deactivation left unowned, never one a moved file's
 * identical content reuses, can be switched off, and reports a failure on
 * the pass result without failing the pass.
 */
import { Database } from "bun:sqlite";
import { afterEach, expect, mock, test } from "bun:test";

import type { EmbedBacklogDeps } from "../../src/embed/backlog";
import type { EmbeddingPort } from "../../src/llm/types";
import type { VectorIndexPort } from "../../src/store/vector";

import { embedBacklog } from "../../src/embed/backlog";
import { migration as variantsMigration } from "../../src/store/migrations/028-vector-variants";
import { migration as runtimeMigration } from "../../src/store/migrations/031-runtime-independent-vectors";
import { migration as mirrorMigration } from "../../src/store/migrations/036-vector-mirror-state";
import { migration as gcMigration } from "../../src/store/migrations/038-vector-gc-candidates";
import { AUTO_VECTOR_GC_DISABLE_ENV } from "../../src/store/vector/garbage";
import { createVectorStatsPort } from "../../src/store/vector/stats";
import { createVectorVariantStore } from "../../src/store/vector/variants";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  Reflect.deleteProperty(process.env, AUTO_VECTOR_GC_DISABLE_ENV);
});

const identity = {
  model: "test-model",
  modelFingerprint: "test-weights",
  contextSize: 512,
  truncationPolicy: "test-tail-v1",
  dimensions: 3,
};

function embedPort() {
  const embedBatch = mock((texts: string[]) =>
    Promise.resolve({ ok: true, value: texts.map(() => [0.1, 0.2, 0.3]) })
  );
  const port = {
    embedBatch,
    embed: mock(() => Promise.resolve({ ok: true, value: [0.1, 0.2, 0.3] })),
    dimensions: () => 3,
    init: () => Promise.resolve({ ok: true }),
    dispose: () => Promise.resolve(),
    modelUri: "test-model",
  } as unknown as EmbeddingPort;
  return { port, embedBatch };
}

/** Three one-chunk documents in two collections, embedded once. */
async function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE documents(id INTEGER PRIMARY KEY, mirror_hash TEXT, title TEXT, active INTEGER, collection TEXT);
    CREATE INDEX idx_documents_collection ON documents(collection);
    CREATE INDEX idx_documents_mirror_hash ON documents(mirror_hash);
    CREATE TABLE content_chunks(mirror_hash TEXT, seq INTEGER, text TEXT, PRIMARY KEY(mirror_hash, seq));
    CREATE TABLE content_vectors(mirror_hash TEXT, seq INTEGER, model TEXT, embedding BLOB);
    INSERT INTO documents VALUES (1, 'm1', 'One', 1, 'prose'), (2, 'm2', 'Two', 1, 'prose'),
      (3, 'm3', 'Three', 1, 'data');
    INSERT INTO content_chunks VALUES ('m1', 0, 'first'), ('m2', 0, 'second'), ('m3', 0, 'third');`);
  for (const m of [
    variantsMigration,
    runtimeMigration,
    mirrorMigration,
    gcMigration,
  ])
    m.up(db, "unicode61");
  const store = await createVectorVariantStore(db, identity);
  const embed = embedPort();
  const deps: EmbedBacklogDeps = {
    statsPort: createVectorStatsPort(db),
    embedPort: embed.port,
    vectorIndex: {
      searchAvailable: true,
      model: "test-model",
      dimensions: 3,
      vecDirty: false,
    } as unknown as VectorIndexPort,
    modelUri: "test-model",
    variantStore: store,
    identityStillCurrent: () => true,
  };
  const first = await embedBacklog(deps);
  expect(first.ok && first.value.embedded).toBe(3);
  expect(store.hasActivated()).toBe(true);
  embed.embedBatch.mockClear();
  return { db, store, deps, embedBatch: embed.embedBatch };
}

const n = (db: Database, sql: string): number =>
  db.query<{ n: number }, []>(sql).get()!.n;

test("an embed pass collects the variants deactivation left unowned, with their mirror rows", async () => {
  const { db, store, deps } = await fixture();
  // Nothing queued: the pass reports no collection.
  const idle = await embedBacklog(deps);
  expect(idle.ok && idle.value.vectorGc).toBeUndefined();

  db.run("UPDATE documents SET active = 0 WHERE id = 2");
  const pass = await embedBacklog(deps);
  expect(pass.ok && pass.value.vectorGc).toEqual({
    variants: 1,
    bytes: 12,
    remaining: false,
  });
  expect(n(db, "SELECT count(*) AS n FROM vector_variants")).toBe(2);
  expect(n(db, `SELECT count(*) AS n FROM ${store.tableName}`)).toBe(2);
  expect(store.mirrorState()).toBe("clean");
  expect(store.hasActivated()).toBe(true);
  expect(n(db, "SELECT count(*) AS n FROM vector_gc_candidates")).toBe(0);
});

test("moving a file across collections re-embeds nothing with automatic GC on", async () => {
  const { db, deps, embedBatch } = await fixture();
  // Sync deactivates the old path and adds the identical file elsewhere.
  db.run("UPDATE documents SET active = 0 WHERE id = 3");
  db.run("INSERT INTO documents VALUES (4, 'm3', 'Three', 1, 'prose')");
  const pass = await embedBacklog(deps);
  expect(pass.ok && pass.value.embedded).toBe(1);
  expect(embedBatch).not.toHaveBeenCalled();
  expect(pass.ok && pass.value.vectorGc).toEqual({
    variants: 0,
    bytes: 0,
    remaining: false,
  });
  expect(n(db, "SELECT count(*) AS n FROM vector_variants")).toBe(3);
  expect(
    n(db, "SELECT count(*) AS n FROM vector_owners WHERE document_id = 4")
  ).toBe(1);
});

test("a bounded pass that stops at its limit leaves garbage queued for the next pass", async () => {
  const { db, deps } = await fixture();
  db.run("UPDATE documents SET active = 0 WHERE id = 1");
  db.run(
    "INSERT INTO content_chunks VALUES ('m5', 0, 'fifth'), ('m6', 0, 'sixth')"
  );
  db.run(
    "INSERT INTO documents VALUES (5, 'm5', 'Five', 1, 'prose'), (6, 'm6', 'Six', 1, 'prose')"
  );
  const bounded = await embedBacklog({
    ...deps,
    batchSize: 1,
    limits: { maxChunks: 1 },
  });
  expect(bounded.ok && bounded.value.stopped).toBe("limit");
  expect(bounded.ok && bounded.value.vectorGc).toBeUndefined();
  expect(n(db, "SELECT count(*) AS n FROM vector_gc_candidates")).toBe(1);
  const full = await embedBacklog(deps);
  expect(full.ok && full.value.vectorGc?.variants).toBe(1);
});

test("the environment switch turns automatic GC off", async () => {
  const { db, deps } = await fixture();
  process.env[AUTO_VECTOR_GC_DISABLE_ENV] = "1";
  db.run("UPDATE documents SET active = 0 WHERE id = 2");
  const pass = await embedBacklog(deps);
  expect(pass.ok && pass.value.vectorGc).toBeUndefined();
  expect(n(db, "SELECT count(*) AS n FROM vector_variants")).toBe(3);
  expect(n(db, "SELECT count(*) AS n FROM vector_gc_candidates")).toBe(1);
});

test("a GC failure is reported on the pass result and never fails the pass", async () => {
  const { db, deps } = await fixture();
  db.run("UPDATE documents SET active = 0 WHERE id = 2");
  // Variant deletion fails inside the GC transaction.
  db.run(
    "CREATE TRIGGER fail_variant_delete BEFORE DELETE ON vector_variants BEGIN SELECT RAISE(ABORT, 'variant delete blocked'); END"
  );
  const pass = await embedBacklog(deps);
  expect(pass.ok).toBe(true);
  expect(pass.ok && pass.value.vectorGcError).toContain(
    "variant delete blocked"
  );
  expect(n(db, "SELECT count(*) AS n FROM vector_variants")).toBe(3);
  expect(n(db, "SELECT count(*) AS n FROM vector_gc_candidates")).toBe(1);
});
