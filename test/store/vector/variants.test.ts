import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
// Bun has no temporary-directory creation/path API.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { VectorVariantIdentity } from "../../../src/store/vector/types";

import { migration } from "../../../src/store/migrations/028-vector-variants";
import {
  createVectorVariantStore,
  VectorVariantStore,
} from "../../../src/store/vector/variants";
import { safeRm } from "../../helpers/cleanup";

const identity: VectorVariantIdentity = {
  model: "model-a",
  modelFingerprint: "weights-a",
  contextSize: 512,
  truncationPolicy: "truncate-tail-v1",
  dimensions: 2,
};
const databases: Database[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) await safeRm(directory);
});

function fixture(path = ":memory:"): Database {
  const db = new Database(path);
  databases.push(db);
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE documents(id INTEGER PRIMARY KEY, mirror_hash TEXT, title TEXT, active INTEGER);
    CREATE TABLE content_chunks(mirror_hash TEXT, seq INTEGER, text TEXT, PRIMARY KEY(mirror_hash, seq));
    CREATE TABLE content_vectors(mirror_hash TEXT, seq INTEGER, model TEXT, embedding BLOB);
    INSERT INTO documents VALUES (1, 'body', 'Alpha', 1), (2, 'body', 'Beta', 1), (3, 'body', 'Alpha', 1);
    INSERT INTO content_chunks VALUES ('body', 0, 'Shared body');
    INSERT INTO content_vectors VALUES ('body', 0, 'model-a', X'0000803f00000000');
  `);
  migration.up(db, "unicode61");
  return db;
}

test("Alpha/Beta coexist; exact input shares a variant and only its current owners", async () => {
  const db = fixture();
  const store = await createVectorVariantStore(db, identity);
  expect(store.searchAvailable).toBe(true);
  const [alpha, beta, same] = store.pending();
  const ids = store.write([
    { owner: alpha!, embedding: new Float32Array([1, 0]) },
    { owner: beta!, embedding: new Float32Array([0, 1]) },
    { owner: same! },
  ]);
  expect(ids[0]).not.toBe(ids[1]);
  expect(ids[0]).toBe(ids[2]);
  expect(store.owners(ids[0]!).map((x) => x.documentId)).toEqual([1, 3]);
  expect(store.owners(ids[1]!).map((x) => x.documentId)).toEqual([2]);
  expect(store.pending()).toEqual([]);
  expect(
    db.query(`SELECT count(*) AS n FROM ${store.tableName}`).get()
  ).toEqual({ n: 2 });
  store.activate(store.epoch());
  expect(store.isActive()).toBe(true);
  expect(store.hasActivated()).toBe(true);
  db.run("INSERT INTO documents VALUES (4, 'body', 'Gamma', 1)");
  expect(store.isActive()).toBe(false);
  expect(store.hasActivated()).toBe(true);
  expect(store.owners(ids[0]!).map((x) => x.documentId)).toEqual([1, 3]);
  expect(store.pending().map((x) => x.documentId)).toEqual([4]);
  db.run("UPDATE documents SET title = 'Beta' WHERE id = 1");
  expect(store.isActive()).toBe(false);
  expect(store.hasActivated()).toBe(true);
  expect(store.owners(ids[0]!).map((x) => x.documentId)).toEqual([3]);
  expect(store.pending().map((x) => x.documentId)).toEqual([1, 4]);
});

test("shadow resumes without blessing any legacy vector, including unique owners", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gno-variants-"));
  directories.push(directory);
  const path = join(directory, "index.sqlite");
  let db = fixture(path);
  db.run("DELETE FROM documents WHERE id > 1");
  const initial = new VectorVariantStore(db, identity, false);
  expect(initial.hasActivated()).toBe(false);
  expect(initial.pending()).toHaveLength(1);
  expect(() => initial.activate(initial.epoch())).toThrow(
    "coverage incomplete"
  );
  expect(initial.reusable(initial.pending()[0]!)).toBeNull();
  expect(db.query("SELECT count(*) AS n FROM content_vectors").get()).toEqual({
    n: 1,
  });
  initial.write([
    { owner: initial.pending()[0]!, embedding: new Float32Array([1, 0]) },
  ]);
  expect(() => initial.activate(initial.epoch())).toThrow("index unavailable");
  db.close();
  databases.pop();
  db = new Database(path);
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON");
  const resumed = await createVectorVariantStore(db, identity);
  expect(resumed.pending()).toEqual([]);
  resumed.syncIndex();
  resumed.activate(resumed.epoch());
  expect(resumed.isActive()).toBe(true);
  db.exec(`DROP TABLE ${resumed.tableName}`);
  const rebuilt = await createVectorVariantStore(db, identity);
  expect(rebuilt.hasActivated()).toBe(false);
  expect(rebuilt.isActive()).toBe(false);
  expect(db.query("SELECT count(*) AS n FROM content_vectors").get()).toEqual({
    n: 1,
  });
});

test("model, fingerprint, context, policy and dimensions partition identity", async () => {
  const db = fixture();
  const first = await createVectorVariantStore(db, identity);
  first.write([
    { owner: first.pending()[0]!, embedding: new Float32Array([1, 0]) },
  ]);
  const partitions = new Set([first.partitionId]);
  for (const change of [
    { model: "model-b" },
    { modelFingerprint: "weights-b" },
    { contextSize: 256 },
    { truncationPolicy: "reject-long-v1" },
    { dimensions: 3 },
  ]) {
    const store = await createVectorVariantStore(db, {
      ...identity,
      ...change,
    });
    partitions.add(store.partitionId);
    const owner = store.pending()[0]!;
    expect(store.reusable(owner)).toBeNull();
    store.write([
      { owner, embedding: new Float32Array(store.identity.dimensions).fill(1) },
    ]);
    expect(store.owners(1)).toEqual([]);
  }
  expect(partitions.size).toBe(6);
  const owner = first.pending()[0]!;
  for (const embedding of [
    new Float32Array([1]),
    new Float32Array([1, Number.NaN]),
  ]) {
    expect(() => first.write([{ owner, embedding }])).toThrow(
      "dimensions or values"
    );
  }
});

test("write rollback preserves authoritative row, owners and vec0, including materialization failure", async () => {
  const db = fixture();
  const store = await createVectorVariantStore(db, identity);
  const [alpha, beta] = store.pending();
  store.write([{ owner: alpha!, embedding: new Float32Array([1, 0]) }]);
  const before = store.epoch();
  db.exec(`CREATE TRIGGER fail_owner BEFORE INSERT ON vector_owners WHEN NEW.document_id = 2
    BEGIN SELECT RAISE(ABORT, 'injected interruption'); END;`);
  expect(() =>
    store.write([
      { owner: store.current(3, 0)! },
      { owner: beta!, embedding: new Float32Array([0, 1]) },
    ])
  ).toThrow("injected interruption");
  expect(store.epoch()).toBe(before);
  expect(db.query("SELECT count(*) AS n FROM vector_variants").get()).toEqual({
    n: 1,
  });
  expect(
    db.query(`SELECT count(*) AS n FROM ${store.tableName}`).get()
  ).toEqual({ n: 1 });
  const unavailable = new VectorVariantStore(db, identity, false);
  expect(() => unavailable.write([{ owner: store.current(1, 0)! }])).toThrow(
    "without sqlite-vec"
  );
  expect(() => unavailable.release(1)).toThrow("without sqlite-vec");
  expect(store.epoch()).toBe(before);
  expect(store.owners(1).map((x) => x.documentId)).toEqual([1]);
  db.exec("DROP TRIGGER fail_owner");
  db.exec(`DROP TABLE ${store.tableName}`);
  expect(() =>
    store.write([{ owner: beta!, embedding: new Float32Array([0, 1]) }])
  ).toThrow();
  expect(db.query("SELECT count(*) AS n FROM vector_variants").get()).toEqual({
    n: 1,
  });
  expect(store.epoch()).toBe(before);
});

test("only final valid owner permits GC; canonical replacement does not cascade", async () => {
  const db = fixture();
  const store = await createVectorVariantStore(db, identity);
  const inputs = store.pending();
  const ids = store.write(
    inputs.map((owner) => ({ owner, embedding: new Float32Array([1, 0]) }))
  );
  db.exec(
    "DELETE FROM content_chunks; INSERT INTO content_chunks VALUES ('body', 0, 'Shared body')"
  );
  expect(store.pending()).toEqual([]);
  store.release(1);
  expect(store.owners(ids[0]!).map((x) => x.documentId)).toEqual([3]);
  expect(store.reusable(store.current(3, 0)!)).not.toBeNull();
  store.release(3);
  expect(store.reusable(store.current(3, 0)!)).toBeNull();
  expect(store.owners(ids[1]!).map((x) => x.documentId)).toEqual([2]);
  expect(
    db.query(`SELECT count(*) AS n FROM ${store.tableName}`).get()
  ).toEqual({ n: 1 });
  db.run("UPDATE content_chunks SET text = 'Changed body'");
  expect(store.collectGarbage()).toBe(1);
  expect(
    db.query(`SELECT count(*) AS n FROM ${store.tableName}`).get()
  ).toEqual({ n: 0 });
});

test("activation fences mutations, rejects stale snapshots and inconsistent index", async () => {
  const db = fixture();
  const store = await createVectorVariantStore(db, identity);
  const inputs = store.pending();
  store.write(
    inputs.map((owner) => ({ owner, embedding: new Float32Array([1, 0]) }))
  );
  const epoch = store.epoch();
  db.run("UPDATE documents SET active = 0 WHERE id = 3");
  expect(() => store.activate(epoch)).toThrow("epoch changed");
  expect(() => store.write([{ owner: inputs[2]! }])).toThrow("Stale");
  db.run("UPDATE documents SET mirror_hash = 'other' WHERE id = 1");
  expect(() => store.write([{ owner: inputs[0]! }])).toThrow("Stale");
  db.run(`DELETE FROM ${store.tableName} WHERE variant_id = 2`);
  expect(() => store.activate(store.epoch())).toThrow("index inconsistent");
  expect(store.isActive()).toBe(false);
});
