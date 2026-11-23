/**
 * Owner-aware vector GC (gno#361): liveness across partitions and shared
 * content, a read-only dry run, the trigger-fed candidate queue, bounded
 * resumable collection, mirror-mark guarantees and snapshot consistency.
 */
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
// Bun has no temporary-directory creation API.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { VectorVariantIdentity } from "../../../src/store/vector/types";

import { formatDocForEmbedding } from "../../../src/pipeline/contextual";
import { migration as variantsMigration } from "../../../src/store/migrations/028-vector-variants";
import { migration as runtimeMigration } from "../../../src/store/migrations/031-runtime-independent-vectors";
import { migration as mirrorMigration } from "../../../src/store/migrations/036-vector-mirror-state";
import { migration as gcMigration } from "../../../src/store/migrations/038-vector-gc-candidates";
import {
  collectQueuedGarbage,
  hasQueuedGarbage,
  runVectorGc,
} from "../../../src/store/vector/garbage";
import {
  createVectorVariantStore,
  embeddingInputHash,
  type VectorVariantStore,
} from "../../../src/store/vector/variants";
import { safeRm } from "../../helpers/cleanup";

const A: VectorVariantIdentity = {
  model: "model-a",
  modelFingerprint: "weights-a",
  contextSize: 512,
  truncationPolicy: "truncate-tail-v1",
  dimensions: 2,
};
const B: VectorVariantIdentity = { ...A, modelFingerprint: "weights-b" };

const databases: Database[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) await safeRm(directory);
});

/**
 * Documents 1 and 3 share content and title (one variant); 2 has the same
 * content under another title (its own variant); 4 has its own content.
 */
function fixture(path = ":memory:", migrate = true): Database {
  const db = new Database(path);
  databases.push(db);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE documents(id INTEGER PRIMARY KEY, mirror_hash TEXT, title TEXT, active INTEGER, updated_at TEXT);
    CREATE INDEX idx_documents_mirror_hash ON documents(mirror_hash);
    CREATE TABLE content_chunks(mirror_hash TEXT, seq INTEGER, text TEXT, PRIMARY KEY(mirror_hash, seq));
    CREATE TABLE content_vectors(mirror_hash TEXT, seq INTEGER, model TEXT, embedding BLOB);
    INSERT INTO documents(id, mirror_hash, title, active) VALUES (1, 'body', 'Alpha', 1), (2, 'body', 'Beta', 1),
      (3, 'body', 'Alpha', 1), (4, 'other', 'Delta', 1);
    INSERT INTO content_chunks VALUES ('body', 0, 'Shared body'), ('other', 0, 'Other body');
    INSERT INTO content_vectors VALUES ('body', 0, 'model-a', X'0000803f00000000');
  `);
  variantsMigration.up(db, "unicode61");
  runtimeMigration.up(db, "unicode61");
  mirrorMigration.up(db, "unicode61");
  if (migrate) gcMigration.up(db, "unicode61");
  return db;
}

async function embedAll(
  db: Database,
  identity: VectorVariantIdentity
): Promise<VectorVariantStore> {
  const store = await createVectorVariantStore(db, identity);
  store.write(
    store.pending().map((owner) => ({
      owner,
      embedding: new Float32Array([1, owner.documentId]),
    }))
  );
  store.syncIndex();
  return store;
}

/** The partition fields GC needs, taken from a store. */
const gc = (store: VectorVariantStore) => ({
  partitionId: store.partitionId,
  model: store.identity.model,
});

const count = (db: Database, sql: string): number =>
  db.query<{ n: number }, []>(sql).get()!.n;

const variants = (db: Database, store: VectorVariantStore): number =>
  count(
    db,
    `SELECT count(*) AS n FROM vector_variants WHERE partition_id = '${store.partitionId}'`
  );
const mirrored = (db: Database, store: VectorVariantStore): number =>
  count(db, `SELECT count(*) AS n FROM ${store.tableName}`);

const partitionResult = (
  report: ReturnType<typeof runVectorGc>,
  store: VectorVariantStore
) => report.partitions.find((p) => p.id === store.partitionId)!;

test("a variant stays while any active document with its content produces it, in every partition", async () => {
  const db = fixture();
  const a = await embedAll(db, A);
  const b = await embedAll(db, B);
  expect(variants(db, a)).toBe(3);
  expect(variants(db, b)).toBe(3);

  // Shared content: deactivating one of two owners keeps the variant.
  db.run("UPDATE documents SET active = 0 WHERE id = 1");
  let report = runVectorGc(db, { dryRun: true, vecLoaded: true });
  expect(report.variants).toBe(0);
  expect(report.partitions.map((p) => p.examined)).toEqual([3, 3]);

  // Last owner gone: collectible in both partitions, each on its own owners.
  db.run("UPDATE documents SET active = 0 WHERE id IN (3, 4)");
  report = runVectorGc(db, { dryRun: true, vecLoaded: true });
  expect(partitionResult(report, a).variants).toBe(2);
  expect(partitionResult(report, b).variants).toBe(2);
  expect(report.bytes).toBe(4 * 2 * 4);
  expect(report.legacyContentVectors).toBe(1);

  const real = runVectorGc(db, { dryRun: false, vecLoaded: true });
  expect(real.partitions.map((p) => [p.variants, p.bytes])).toEqual(
    report.partitions.map((p) => [p.variants, p.bytes])
  );
  for (const store of [a, b]) {
    expect(variants(db, store)).toBe(1);
    expect(mirrored(db, store)).toBe(1);
    // Beta (document 2) keeps its variant and its binding.
    expect(
      store.owners(store.reusable(store.current(2, 0)!)!.variantId)
    ).toHaveLength(1);
  }
  // Legacy vectors are not touched.
  expect(count(db, "SELECT count(*) AS n FROM content_vectors")).toBe(1);
  expect(runVectorGc(db, { dryRun: false, vecLoaded: true }).variants).toBe(0);
});

test("legacy-keyed and shadow partitions are traversed with the same rule", async () => {
  const db = fixture();
  const a = await embedAll(db, A);
  db.run(
    "UPDATE vector_partitions SET legacy = 1, state = 'shadow', activated_epoch = NULL"
  );
  db.run("UPDATE documents SET active = 0 WHERE id = 4");
  const report = runVectorGc(db, { dryRun: false, vecLoaded: true });
  expect(report.partitions).toEqual([
    expect.objectContaining({
      id: a.partitionId,
      state: "shadow",
      legacy: true,
      examined: 3,
      variants: 1,
    }),
  ]);
});

test("identical content not yet re-bound keeps its variant (a moved file before embedding)", async () => {
  const db = fixture();
  const a = await embedAll(db, A);
  db.run("UPDATE documents SET active = 0 WHERE id = 4");
  db.run(
    "INSERT INTO documents(id, mirror_hash, title, active) VALUES (5, 'other', 'Delta', 1)"
  );
  expect(runVectorGc(db, { dryRun: true, vecLoaded: true }).variants).toBe(0);
  expect(
    collectQueuedGarbage(db, gc(a), { vecLoaded: true, graceSeconds: 0 })
      .variants
  ).toBe(0);
  // The next embed reuses it without a new vector.
  expect(a.reusable(a.current(5, 0)!)).not.toBeNull();
  // A title change alters the input: the old vector is garbage.
  db.run("UPDATE documents SET title = 'Delta moved' WHERE id = 5");
  expect(runVectorGc(db, { dryRun: true, vecLoaded: true }).variants).toBe(1);
});

test("dry run is read-only: file bytes, rows, epoch, mirror marks and partitions unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gno-vec-gc-dry-"));
  directories.push(directory);
  const path = join(directory, "index.sqlite");
  const db = fixture(path);
  await embedAll(db, A);
  db.run("UPDATE documents SET active = 0 WHERE id IN (2, 4)");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const snapshot = (target: Database) => ({
    tables: [
      "documents",
      "vector_variants",
      "vector_owners",
      "vector_partitions",
      "vector_mirror_state",
      "vector_gc_candidates",
    ].map((table) =>
      target.query(`SELECT * FROM ${table} ORDER BY 1, 2`).all()
    ),
    epoch: target.query("SELECT epoch FROM vector_variant_epoch").get(),
  });
  const before = snapshot(db);
  const bytes = await Bun.file(path).bytes();
  const wal = await Bun.file(`${path}-wal`).bytes();

  const readOnly = new Database(path, { readonly: true });
  databases.push(readOnly);
  readOnly.exec("PRAGMA query_only = ON");
  const { loadSqliteVec } = await import("../../../src/store/vector/variants");
  const report = runVectorGc(readOnly, {
    dryRun: true,
    vecLoaded: await loadSqliteVec(readOnly),
  });
  expect(report.variants).toBe(2);
  expect(report.dryRun).toBe(true);

  expect(snapshot(db)).toEqual(before);
  expect(await Bun.file(path).bytes()).toEqual(bytes);
  expect(await Bun.file(`${path}-wal`).bytes()).toEqual(wal);
});

test("dry run works on a schema without the candidate queue", async () => {
  const db = fixture(":memory:", false);
  await embedAll(db, A);
  db.run("UPDATE documents SET active = 0 WHERE id = 4");
  expect(runVectorGc(db, { dryRun: true, vecLoaded: true }).variants).toBe(1);
});

test("deactivation, unbinding and cascade deletes queue candidates; queued GC removes exactly the unowned", async () => {
  const db = fixture();
  const a = await embedAll(db, A);
  const b = await embedAll(db, B);
  expect(hasQueuedGarbage(db, a.partitionId)).toBe(false);
  expect(
    collectQueuedGarbage(db, gc(a), { vecLoaded: true, graceSeconds: 0 })
  ).toEqual({
    examined: 0,
    variants: 0,
    bytes: 0,
    remaining: false,
  });

  db.run("UPDATE documents SET active = 0 WHERE id IN (1, 4)");
  expect(hasQueuedGarbage(db, a.partitionId)).toBe(true);
  const result = collectQueuedGarbage(db, gc(a), {
    vecLoaded: true,
    graceSeconds: 0,
  });
  // Alpha (shared with 3) stays; Delta goes with its vec0 row.
  expect(result).toEqual({
    examined: 2,
    variants: 1,
    bytes: 8,
    remaining: false,
  });
  expect(variants(db, a)).toBe(2);
  expect(mirrored(db, a)).toBe(2);
  expect(
    count(
      db,
      "SELECT count(*) AS n FROM vector_gc_candidates WHERE partition_id = '" +
        a.partitionId +
        "'"
    )
  ).toBe(0);
  // The other partition's candidates wait for it.
  expect(hasQueuedGarbage(db, b.partitionId)).toBe(true);
  expect(variants(db, b)).toBe(3);

  // A deleted document's bindings go by cascade and still queue.
  db.run("DELETE FROM documents WHERE id = 2");
  expect(hasQueuedGarbage(db, a.partitionId)).toBe(true);
  expect(
    collectQueuedGarbage(db, gc(a), { vecLoaded: true, graceSeconds: 0 })
      .variants
  ).toBe(1);

  // Re-pointing a binding queues the variant it left.
  db.run("UPDATE documents SET active = 1 WHERE id = 4");
  const delta = a.pending()[0]!;
  a.write([{ owner: delta, embedding: new Float32Array([0, 1]) }]);
  db.run(
    "UPDATE content_chunks SET text = 'Other body v2' WHERE mirror_hash = 'other'"
  );
  const changed = a.pending()[0]!;
  const [newId] = a.write([
    { owner: changed, embedding: new Float32Array([1, 1]) },
  ]);
  expect(hasQueuedGarbage(db, a.partitionId)).toBe(true);
  expect(
    collectQueuedGarbage(db, gc(a), { vecLoaded: true, graceSeconds: 0 })
      .variants
  ).toBe(1);
  expect(a.owners(newId!)).toHaveLength(1);
});

test("bounded queued runs resume where they stopped", async () => {
  const db = fixture();
  for (let id = 10; id < 17; id++) {
    db.run("INSERT INTO content_chunks VALUES (?, 0, ?)", [
      `m${id}`,
      `text ${id}`,
    ]);
    db.run(
      "INSERT INTO documents(id, mirror_hash, title, active) VALUES (?, ?, 'T', 1)",
      [id, `m${id}`]
    );
  }
  const a = await embedAll(db, A);
  db.run("UPDATE documents SET active = 0 WHERE id >= 10");
  const first = collectQueuedGarbage(db, gc(a), {
    vecLoaded: true,
    graceSeconds: 0,
    batchSize: 2,
    maxCandidates: 4,
  });
  expect(first).toEqual({
    examined: 4,
    variants: 4,
    bytes: 32,
    remaining: true,
  });
  const second = collectQueuedGarbage(db, gc(a), {
    vecLoaded: true,
    graceSeconds: 0,
    batchSize: 2,
  });
  expect(second).toEqual({
    examined: 3,
    variants: 3,
    bytes: 24,
    remaining: false,
  });
  expect(variants(db, a)).toBe(3);
  expect(mirrored(db, a)).toBe(3);
  // A zero time budget starts no batch and leaves everything queued.
  db.run("UPDATE documents SET active = 0 WHERE id = 4");
  expect(
    collectQueuedGarbage(db, gc(a), {
      vecLoaded: true,
      graceSeconds: 0,
      budgetMs: 0,
    }).remaining
  ).toBe(true);
});

test("a clean mirror stays clean, a dirty mirror stays dirty", async () => {
  const db = fixture();
  const a = await embedAll(db, A);
  a.activate(a.epoch());
  expect(a.mirrorState()).toBe("clean");
  db.run("UPDATE documents SET active = 0 WHERE id = 4");
  expect(
    collectQueuedGarbage(db, gc(a), { vecLoaded: true, graceSeconds: 0 })
      .variants
  ).toBe(1);
  expect(a.mirrorState()).toBe("clean");
  expect(a.hasActivated()).toBe(true);

  db.run("DELETE FROM vector_mirror_state");
  expect(a.mirrorState()).toBe("dirty");
  db.run("UPDATE documents SET active = 0 WHERE id = 2");
  expect(runVectorGc(db, { dryRun: false, vecLoaded: true }).variants).toBe(1);
  expect(a.mirrorState()).toBe("dirty");
  expect(a.hasActivated()).toBe(true);
});

test("a vec0 index without sqlite-vec is skipped and reported, never mutated", async () => {
  const db = fixture();
  const a = await embedAll(db, A);
  db.run("UPDATE documents SET active = 0 WHERE id = 4");
  const report = runVectorGc(db, { dryRun: false, vecLoaded: false });
  expect(partitionResult(report, a)).toEqual(
    expect.objectContaining({
      variants: 0,
      skipped: expect.stringContaining("sqlite-vec"),
    })
  );
  expect(variants(db, a)).toBe(3);
  expect(() =>
    collectQueuedGarbage(db, gc(a), { vecLoaded: false, graceSeconds: 0 })
  ).toThrow("sqlite-vec");
  expect(variants(db, a)).toBe(3);
});

test("a concurrent reader sees each GC batch entirely or not at all", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gno-vec-gc-read-"));
  directories.push(directory);
  const path = join(directory, "index.sqlite");
  const db = fixture(path);
  for (let id = 10; id < 20; id++) {
    db.run("INSERT INTO content_chunks VALUES (?, 0, ?)", [
      `m${id}`,
      `text ${id}`,
    ]);
    db.run(
      "INSERT INTO documents(id, mirror_hash, title, active) VALUES (?, ?, 'T', 1)",
      [id, `m${id}`]
    );
  }
  const a = await embedAll(db, A);
  const reader = new Database(path);
  databases.push(reader);
  const { loadSqliteVec } = await import("../../../src/store/vector/variants");
  expect(await loadSqliteVec(reader)).toBe(true);
  const observe = () => ({
    variants: count(reader, "SELECT count(*) AS n FROM vector_variants"),
    mirrored: count(reader, `SELECT count(*) AS n FROM ${a.tableName}`),
    dangling: count(
      reader,
      `SELECT count(*) AS n FROM vector_owners o WHERE NOT EXISTS (
        SELECT 1 FROM vector_variants v WHERE v.variant_id = o.variant_id)`
    ),
  });
  db.run("UPDATE documents SET active = 0 WHERE id >= 10");
  // A read transaction keeps its snapshot through the whole collection.
  reader.exec("BEGIN");
  const before = observe();
  const collected = collectQueuedGarbage(db, gc(a), {
    vecLoaded: true,
    graceSeconds: 0,
    batchSize: 3,
  });
  expect(collected.variants).toBe(10);
  expect(observe()).toEqual(before);
  reader.exec("COMMIT");
  const after = observe();
  expect(after).toEqual({ variants: 3, mirrored: 3, dangling: 0 });
  expect(before).toEqual({ variants: 13, mirrored: 13, dangling: 0 });
});

test("automatic collection waits out the grace; a new loss restarts it", async () => {
  const db = fixture();
  const a = await embedAll(db, A);
  db.run("UPDATE documents SET active = 0 WHERE id = 4");
  const age = (seconds: number) =>
    db.run("UPDATE vector_gc_candidates SET queued_at = queued_at - ?", [
      seconds,
    ]);
  // Inside the 7-day default grace nothing is due or touched.
  expect(collectQueuedGarbage(db, gc(a), { vecLoaded: true })).toEqual({
    examined: 0,
    variants: 0,
    bytes: 0,
    remaining: false,
  });
  expect(hasQueuedGarbage(db, a.partitionId)).toBe(true);
  // Restored and lost again after six days: the grace starts over.
  age(6 * 86_400);
  db.run("UPDATE documents SET active = 1 WHERE id = 4");
  db.run("UPDATE documents SET active = 0 WHERE id = 4");
  age(2 * 86_400);
  expect(collectQueuedGarbage(db, gc(a), { vecLoaded: true }).examined).toBe(0);
  age(6 * 86_400);
  expect(collectQueuedGarbage(db, gc(a), { vecLoaded: true }).variants).toBe(1);
});

test("store GC keeps its strict rule: unbound identical content does not keep a variant", async () => {
  const db = fixture();
  const a = await embedAll(db, A);
  db.run("UPDATE documents SET active = 0 WHERE id = 4");
  db.run(
    "INSERT INTO documents(id, mirror_hash, title, active) VALUES (5, 'other', 'Delta', 1)"
  );
  // vec gc and automatic GC keep it for reuse ...
  expect(runVectorGc(db, { dryRun: true, vecLoaded: true }).variants).toBe(0);
  // ... runtime-reference maintenance does not.
  expect(a.collectGarbage()).toBe(1);
  expect(a.reusable(a.current(5, 0)!)).toBeNull();
});

test("GC never makes a count-drifted mirror look clean", async () => {
  const db = fixture();
  const a = await embedAll(db, A);
  a.activate(a.epoch());
  expect(a.mirrorState()).toBe("clean");
  // vec0 lost Beta's and Delta's rows and gained a stray one; the clean
  // mark survives (vec0 has no triggers), the row counts give it away.
  const beta = a.reusable(a.current(2, 0)!)!.variantId;
  const delta = a.reusable(a.current(4, 0)!)!.variantId;
  db.run(`DELETE FROM ${a.tableName} WHERE variant_id IN (?, ?)`, [
    beta,
    delta,
  ]);
  db.run(`INSERT INTO ${a.tableName}(variant_id, embedding) VALUES (999, ?)`, [
    new Uint8Array(new Float32Array([0, 1]).buffer),
  ]);
  expect(a.mirrorState()).toBe("dirty");
  // Collecting Delta (no vec0 row) would equalize the counts.
  db.run("UPDATE documents SET active = 0 WHERE id = 4");
  expect(
    collectQueuedGarbage(db, gc(a), { vecLoaded: true, graceSeconds: 0 })
      .variants
  ).toBe(1);
  expect(a.mirrorState()).toBe("dirty");
});

test("a dry run reads a schema from before runtime-independent partitions", () => {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE documents(id INTEGER PRIMARY KEY, mirror_hash TEXT, title TEXT, active INTEGER);
    CREATE TABLE content_chunks(mirror_hash TEXT, seq INTEGER, text TEXT, PRIMARY KEY(mirror_hash, seq));
    INSERT INTO documents VALUES (1, 'm', 'Kept', 1), (2, 'n', 'Gone', 0);
    INSERT INTO content_chunks VALUES ('m', 0, 'kept body'), ('n', 0, 'gone body');`);
  variantsMigration.up(db, "unicode61");
  db.run(
    "INSERT INTO vector_partitions(partition_id, version, model, fingerprint, dimensions) VALUES ('p28', 1, 'model-a', 'f', 2)"
  );
  const hash = (text: string, title: string) =>
    embeddingInputHash(formatDocForEmbedding(text, title, "model-a"));
  for (const [id, doc, mirror, text, title] of [
    [1, 1, "m", "kept body", "Kept"],
    [2, 2, "n", "gone body", "Gone"],
  ] as const) {
    db.run(
      "INSERT INTO vector_variants(variant_id, partition_id, input_hash, embedding) VALUES (?, 'p28', ?, ?)",
      [id, hash(text, title), new Uint8Array(8)]
    );
    db.run("INSERT INTO vector_owners VALUES (?, ?, 0, 'p28', ?)", [
      doc,
      mirror,
      id,
    ]);
  }
  const report = runVectorGc(db, { dryRun: true, vecLoaded: true });
  expect(report.partitions).toEqual([
    expect.objectContaining({
      id: "p28",
      legacy: true,
      examined: 2,
      variants: 1,
      bytes: 8,
    }),
  ]);
});

test("many bindings of shared content are judged once per content and title", async () => {
  const db = fixture();
  // 60 deactivated copies bound to one variant, 60 active copies whose
  // title differs (a different input): collectible; one active copy with
  // the original title keeps it.
  for (let id = 100; id < 160; id++)
    db.run(
      "INSERT INTO documents(id, mirror_hash, title, active) VALUES (?, 'shared', 'Same', 1)",
      [id]
    );
  db.run("INSERT INTO content_chunks VALUES ('shared', 0, 'shared body')");
  const a = await embedAll(db, A);
  db.run("UPDATE documents SET active = 0 WHERE id >= 100");
  for (let id = 200; id < 260; id++)
    db.run(
      "INSERT INTO documents(id, mirror_hash, title, active) VALUES (?, 'shared', 'Other', 1)",
      [id]
    );
  const shared = db
    .query<{ n: number }, []>(
      "SELECT count(DISTINCT variant_id) AS n FROM vector_owners WHERE document_id >= 100"
    )
    .get()!.n;
  expect(shared).toBe(1);
  expect(runVectorGc(db, { dryRun: true, vecLoaded: true }).variants).toBe(1);
  db.run(
    "INSERT INTO documents(id, mirror_hash, title, active) VALUES (300, 'shared', 'Same', 1)"
  );
  expect(runVectorGc(db, { dryRun: true, vecLoaded: true }).variants).toBe(0);
});
