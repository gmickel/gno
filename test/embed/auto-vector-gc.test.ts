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
import {
  commitVariantBatch,
  prepareVariantBatch,
} from "../../src/embed/variant-retry";
import { migration as variantsMigration } from "../../src/store/migrations/028-vector-variants";
import { migration as runtimeMigration } from "../../src/store/migrations/031-runtime-independent-vectors";
import { migration as mirrorMigration } from "../../src/store/migrations/036-vector-mirror-state";
import { migration as nullCosineMigration } from "../../src/store/migrations/038-vector-mirror-null-cosine";
import { migration as v2MirrorMigration } from "../../src/store/migrations/039-vector-mirror-v2";
import { migration as gcMigration } from "../../src/store/migrations/040-vector-gc-candidates";
import { v2TableName } from "../../src/store/vector/coarse-router";
import {
  AUTO_VECTOR_GC_DISABLE_ENV,
  AUTO_VECTOR_GC_GRACE_SECONDS,
  runVectorGc,
} from "../../src/store/vector/garbage";
import { syncPartitionIndexWithDetails } from "../../src/store/vector/partition-index";
import { createVectorStatsPort } from "../../src/store/vector/stats";
import {
  markV2MirrorClean,
  readV2MirrorState,
  v2MirrorFreshnessState,
} from "../../src/store/vector/v2-mirror";
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
    CREATE TABLE documents(id INTEGER PRIMARY KEY, mirror_hash TEXT, title TEXT, active INTEGER, collection TEXT, updated_at TEXT);
    CREATE INDEX idx_documents_collection ON documents(collection);
    CREATE INDEX idx_documents_mirror_hash ON documents(mirror_hash);
    CREATE TABLE content_chunks(mirror_hash TEXT, seq INTEGER, text TEXT, PRIMARY KEY(mirror_hash, seq));
    CREATE TABLE content_vectors(mirror_hash TEXT, seq INTEGER, model TEXT, embedding BLOB);
    INSERT INTO documents(id, mirror_hash, title, active, collection) VALUES (1, 'm1', 'One', 1, 'prose'), (2, 'm2', 'Two', 1, 'prose'),
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

/** Move every queued candidate past the automatic-collection grace. */
const pastGrace = (db: Database): void => {
  db.run("UPDATE vector_gc_candidates SET queued_at = queued_at - ?", [
    AUTO_VECTOR_GC_GRACE_SECONDS + 1,
  ]);
};

test("an embed pass collects the variants deactivation left unowned, with their mirror rows", async () => {
  const { db, store, deps } = await fixture();
  // Nothing queued: the pass reports no collection.
  const idle = await embedBacklog(deps);
  expect(idle.ok && idle.value.vectorGc).toBeUndefined();

  db.run("UPDATE documents SET active = 0 WHERE id = 2");
  // Inside the grace the pass leaves it alone.
  const early = await embedBacklog(deps);
  expect(early.ok && early.value.vectorGc).toBeUndefined();
  expect(n(db, "SELECT count(*) AS n FROM vector_variants")).toBe(3);
  pastGrace(db);
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
  db.run(
    "INSERT INTO documents(id, mirror_hash, title, active, collection) VALUES (4, 'm3', 'Three', 1, 'prose')"
  );
  pastGrace(db);
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

test("a bounded pass that stops at its limit still collects due garbage", async () => {
  const { db, deps } = await fixture();
  db.run("UPDATE documents SET active = 0 WHERE id = 1");
  db.run(
    "INSERT INTO content_chunks VALUES ('m5', 0, 'fifth'), ('m6', 0, 'sixth')"
  );
  db.run(
    "INSERT INTO documents(id, mirror_hash, title, active, collection) VALUES (5, 'm5', 'Five', 1, 'prose'), (6, 'm6', 'Six', 1, 'prose')"
  );
  pastGrace(db);
  const bounded = await embedBacklog({
    ...deps,
    batchSize: 1,
    limits: { maxChunks: 1 },
  });
  expect(bounded.ok && bounded.value.stopped).toBe("limit");
  expect(bounded.ok && bounded.value.vectorGc).toEqual({
    variants: 1,
    bytes: 12,
    remaining: false,
  });
  expect(n(db, "SELECT count(*) AS n FROM vector_gc_candidates")).toBe(0);
  // The pass still resumes where it stopped.
  const rest = await embedBacklog(deps);
  expect(rest.ok && rest.value.embedded).toBe(1);
});

test("the environment switch turns automatic GC off", async () => {
  const { db, deps } = await fixture();
  process.env[AUTO_VECTOR_GC_DISABLE_ENV] = "1";
  db.run("UPDATE documents SET active = 0 WHERE id = 2");
  pastGrace(db);
  const pass = await embedBacklog(deps);
  expect(pass.ok && pass.value.vectorGc).toBeUndefined();
  expect(n(db, "SELECT count(*) AS n FROM vector_variants")).toBe(3);
  expect(n(db, "SELECT count(*) AS n FROM vector_gc_candidates")).toBe(1);
});

test("a GC failure is reported on the pass result and never fails the pass", async () => {
  const { db, deps } = await fixture();
  db.run("UPDATE documents SET active = 0 WHERE id = 2");
  pastGrace(db);
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

test("a file deleted and restored within the grace is not re-embedded", async () => {
  const { db, deps, embedBatch } = await fixture();
  for (let cycle = 0; cycle < 2; cycle++) {
    db.run("UPDATE documents SET active = 0 WHERE id = 2");
    const gone = await embedBacklog(deps);
    expect(gone.ok && gone.value.vectorGc).toBeUndefined();
    db.run("UPDATE documents SET active = 1 WHERE id = 2");
    const back = await embedBacklog(deps);
    expect(back.ok && back.value.embedded).toBe(0);
  }
  expect(embedBatch).not.toHaveBeenCalled();
  expect(n(db, "SELECT count(*) AS n FROM vector_variants")).toBe(3);
});

test("a failing queue probe is reported and never fails the pass", async () => {
  const { db, deps } = await fixture();
  db.exec(
    "DROP TABLE vector_gc_candidates; CREATE VIEW vector_gc_candidates AS SELECT 1 AS broken"
  );
  const pass = await embedBacklog(deps);
  expect(pass.ok).toBe(true);
  expect(pass.ok && pass.value.vectorGcError).toBeString();
});

test("automatic GC after an embed pass keeps the v2 coarse mirror clean and leaves vec sync with 0 v2 changes", async () => {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE documents(id INTEGER PRIMARY KEY, mirror_hash TEXT, title TEXT, active INTEGER, collection TEXT, updated_at TEXT);
    CREATE INDEX idx_documents_collection ON documents(collection);
    CREATE INDEX idx_documents_mirror_hash ON documents(mirror_hash);
    CREATE TABLE content_chunks(mirror_hash TEXT, seq INTEGER, text TEXT, PRIMARY KEY(mirror_hash, seq));
    CREATE TABLE content_vectors(mirror_hash TEXT, seq INTEGER, model TEXT, embedding BLOB);
    INSERT INTO documents(id, mirror_hash, title, active, collection)
      VALUES (1, 'm1', 'One', 1, 'prose'), (2, 'm2', 'Two', 1, 'data');
    INSERT INTO content_chunks VALUES ('m1', 0, 'first'), ('m2', 0, 'second');`);
  for (const m of [
    variantsMigration,
    runtimeMigration,
    mirrorMigration,
    nullCosineMigration,
    v2MirrorMigration,
    gcMigration,
  ]) {
    m.up(db, "unicode61");
  }

  const v2Identity = { ...identity, dimensions: 8 };
  const store = await createVectorVariantStore(db, v2Identity);
  const vec8 = [0.5, -0.5, 0.25, -0.25, 0.75, -0.75, 0.1, -0.1];
  const embedBatch = mock((texts: string[]) =>
    Promise.resolve({ ok: true, value: texts.map(() => vec8) })
  );
  const port = {
    embedBatch,
    embed: mock(() => Promise.resolve({ ok: true, value: vec8 })),
    dimensions: () => 8,
    init: () => Promise.resolve({ ok: true }),
    dispose: () => Promise.resolve(),
    modelUri: "test-model",
  } as unknown as EmbeddingPort;
  const deps: EmbedBacklogDeps = {
    statsPort: createVectorStatsPort(db),
    embedPort: port,
    vectorIndex: {
      searchAvailable: true,
      model: "test-model",
      dimensions: 8,
      vecDirty: false,
      upsertVectors: () => Promise.resolve({ ok: true, value: undefined }),
      deleteVectorsForMirror: () =>
        Promise.resolve({ ok: true, value: undefined }),
      searchNearest: () => Promise.resolve({ ok: true, value: [] }),
      rebuildVecIndex: () => Promise.resolve({ ok: true, value: undefined }),
      syncVecIndex: () =>
        Promise.resolve({ ok: true, value: { added: 0, removed: 0 } }),
    } as unknown as VectorIndexPort,
    modelUri: "test-model",
    variantStore: store,
    identityStillCurrent: () => true,
  };

  const initial = await embedBacklog(deps);
  expect(initial.ok && initial.value.embedded).toBe(2);
  markV2MirrorClean(db, store.partitionId, {
    recall: 0.98,
    queries: 16,
    coarseK: 200,
  });

  const removedVariantId = db
    .query<{ variant_id: number }, [string]>(
      "SELECT variant_id FROM vector_owners WHERE partition_id = ? AND document_id = 2"
    )
    .get(store.partitionId)!.variant_id;

  db.run("UPDATE documents SET active = 0 WHERE id = 2");
  pastGrace(db);

  const pass = await embedBacklog(deps);
  expect(pass.ok).toBe(true);
  expect(pass.ok && pass.value.vectorGc).toEqual({
    variants: 1,
    bytes: 32,
    remaining: false,
  });
  expect(v2MirrorFreshnessState(db, store.partitionId, 8, true)).toBe("clean");
  expect(readV2MirrorState(db, store.partitionId)).toEqual({
    dirty: 0,
    checkRecall: 0.98,
    checkQueries: 16,
    checkCoarseK: 200,
  });
  expect(
    db
      .query<{ n: number }, [string, number]>(
        "SELECT count(*) AS n FROM vector_partition_rows WHERE partition_id = ? AND variant_id = ?"
      )
      .get(store.partitionId, removedVariantId)?.n
  ).toBe(0);
  const v2Tbl = v2TableName(store.partitionId);
  expect(
    db.query<{ n: number }, []>(`SELECT count(*) AS n FROM "${v2Tbl}"`).get()?.n
  ).toBe(1);

  const synced = syncPartitionIndexWithDetails(db, {
    partitionId: store.partitionId,
    dimensions: 8,
  });
  expect(synced.v2Added).toBe(0);
  expect(synced.v2Removed).toBe(0);
});

test("commitVariantBatch recovers newly inferred vectors when concurrent GC removes a reusable variant", async () => {
  const { db, store } = await fixture();
  // Deactivate doc 2 (its vector stays stored) and add two pending docs:
  // doc 4 has a different mirror_hash but identical formatted text as doc 2
  // (marked reusable by prepareVariantBatch, yet NOT retained by GC's mirror_hash join);
  // doc 5 has brand-new text that must be inferred.
  db.run("UPDATE documents SET active = 0 WHERE id = 2");
  db.run(
    "INSERT INTO content_chunks VALUES ('m4-diff', 0, 'second'), ('m5-new', 0, 'brand new')"
  );
  db.run(
    "INSERT INTO documents(id, mirror_hash, title, active, collection) VALUES (4, 'm4-diff', 'Two', 1, 'prose'), (5, 'm5-new', 'Five', 1, 'prose')"
  );

  const pending = store.pending({ limit: 10 });
  const prepared = prepareVariantBatch({ store, owners: pending });
  expect(prepared.reusable.size).toBe(1);
  expect(prepared.inputs.size).toBe(1);

  // Concurrent GC runs while doc 5 is being inferred and collects doc 2's variant.
  const collected = runVectorGc(db, { dryRun: false, vecLoaded: true });
  expect(collected.variants).toBe(1);

  // Commit with the newly inferred vector for doc 5 only.
  const vectors = new Map<string, Float32Array>();
  for (const hash of prepared.inputs.keys()) {
    vectors.set(hash, new Float32Array([0.4, 0.5, 0.6]));
  }
  const outcome = await commitVariantBatch({
    store,
    owners: prepared.owners,
    reusable: prepared.reusable,
    vectors,
    identityStillCurrent: () => true,
  });
  // Doc 5 committed cleanly (no whole-batch rollback); doc 4 is returned in retryOwners.
  expect(outcome.errors).toBe(0);
  expect(outcome.embedded).toBe(1);
  expect(outcome.retryOwners.map((o) => o.documentId)).toEqual([4]);
});
