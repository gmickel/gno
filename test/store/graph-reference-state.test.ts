import { expect, test } from "bun:test";
// Bun has no temporary directory creation API.
import { mkdtemp } from "node:fs/promises";
// Bun has no OS temporary directory/path utilities.
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  DocumentRow,
  GraphReferenceInventory,
} from "../../src/store/types";

import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

async function open(path = ":memory:") {
  const store = new SqliteAdapter();
  const result = await store.open(path, "porter");
  if (!result.ok) throw new Error(result.error.message);
  await store.syncCollections(
    ["outside", "targets"].map((name) => ({
      name,
      path: "/synthetic/" + name,
      pattern: "**/*.md",
      include: [],
      exclude: [],
    }))
  );
  return store;
}

async function add(store: SqliteAdapter, collection: string, name: string) {
  const result = await store.upsertDocument({
    collection,
    relPath: name + ".md",
    title: name,
    sourceHash: name,
    sourceMime: "text/markdown",
    sourceExt: ".md",
    sourceSize: 10,
    sourceMtime: "2026-09-05T00:00:00Z",
  });
  if (!result.ok) throw new Error(result.error.message);
  const docs = await store.listDocuments();
  if (!docs.ok) throw new Error(docs.error.message);
  const doc = docs.value.find((row) => row.id === result.value.id);
  if (!doc) throw new Error("Missing inserted document");
  return doc;
}

function inventory(
  doc: DocumentRow,
  targets: string[] = []
): GraphReferenceInventory {
  return {
    document: {
      documentId: doc.id,
      collection: doc.collection,
      relPath: doc.relPath,
      docid: doc.docid,
      uri: doc.uri,
      title: doc.title,
      mirrorHash: doc.mirrorHash,
      sourceHash: doc.sourceHash,
      contentType: doc.contentType ?? null,
    },
    references: targets.map((target) => ({ edgeType: "knows", target })),
  };
}

test("outside unresolved targets and old resolver identities survive target addition and deletion", async () => {
  const store = await open();
  try {
    const source = await add(store, "outside", "Source");
    const graph = store.graphReferenceStore();
    const refs = [
      "targets:Future",
      "gno://targets/Future.md",
      "targets/Future.md",
      "Future",
    ];
    graph.begin(1, "config");
    graph.writeInventory(inventory(source, refs));
    graph.complete(graph.state(1, "config").epoch);
    const target = await add(store, "targets", "Future");
    expect(graph.state(1, "config").complete).toBe(false);
    expect(graph.state(1, "config").inProgress).toBe(false);
    expect(
      graph.readInventory()[0]?.references.map((ref) => ref.target)
    ).toEqual(refs);
    graph.writeInventory(inventory(target));
    graph.complete(graph.state(1, "config").epoch);
    store.getRawDb().run("DELETE FROM documents WHERE id = ?", [target.id]);
    expect(graph.readInventory().map((row) => row.document.uri)).toContain(
      target.uri
    );
    expect(graph.state(1, "config").dirty).toBe(true);
  } finally {
    await store.close();
  }
});

test("missing coverage and config/version changes reject completeness; rebuild is idempotent", async () => {
  const store = await open();
  try {
    const doc = await add(store, "outside", "Source");
    const graph = store.graphReferenceStore();
    expect(graph.state(1, "a").complete).toBe(false);
    const epoch = graph.begin(1, "a");
    expect(() => graph.complete(epoch)).toThrow("incomplete");
    graph.writeInventory(inventory(doc, ["Missing"]));
    graph.complete(epoch);
    expect(graph.state(1, "a").complete).toBe(true);
    expect(graph.state(2, "a").complete).toBe(false);
    expect(graph.state(1, "b").complete).toBe(false);
    expect(
      store
        .getRawDb()
        .query("SELECT name FROM sqlite_master WHERE name = 'vector_owners'")
        .get()
    ).not.toBeNull();
    const superseded = graph.begin(2, "b");
    const replacement = graph.begin(2, "b");
    expect(() => graph.complete(superseded)).toThrow("changed");
    expect(() => graph.complete(replacement)).toThrow("incomplete");
    for (let pass = 0; pass < 2; pass++) {
      const next = graph.begin(2, "b");
      graph.writeInventory(inventory(doc, ["Missing"]));
      graph.complete(next);
    }
    expect(graph.readInventory()).toEqual([inventory(doc, ["Missing"])]);
    expect(graph.state(2, "b").complete).toBe(true);
    store
      .getRawDb()
      .run("UPDATE documents SET updated_at = 'later' WHERE id = ?", [doc.id]);
    expect(graph.state(2, "b").complete).toBe(true);
    store
      .getRawDb()
      .run("UPDATE documents SET title = 'Changed' WHERE id = ?", [doc.id]);
    expect(() => graph.complete(epoch)).toThrow("changed");
    expect(() => graph.complete(graph.state(2, "b").epoch)).toThrow("stale");
  } finally {
    await store.close();
  }
});

test("interrupted durable projection and failed inventory transaction cannot claim complete", async () => {
  const root = await mkdtemp(join(tmpdir(), "graph-state-"));
  const path = join(root, "index.sqlite");
  let store = await open(path);
  try {
    const doc = await add(store, "outside", "Source");
    let graph = store.graphReferenceStore();
    const epoch = graph.begin(1, "a");
    graph.writeInventory(inventory(doc, ["Old"]));
    graph.complete(epoch);
    graph.begin(1, "a");
    store.getRawDb()
      .exec(`CREATE TEMP TRIGGER fail_reference BEFORE INSERT ON graph_frontmatter_references
      WHEN NEW.target = 'Bad' BEGIN SELECT RAISE(ABORT, 'injected interruption'); END`);
    expect(() => graph.writeInventory(inventory(doc, ["New", "Bad"]))).toThrow(
      "injected"
    );
    expect(graph.readInventory()[0]?.references).toEqual([
      { edgeType: "knows", target: "Old" },
    ]);
    await store.close();
    store = await open(path);
    graph = store.graphReferenceStore();
    expect(graph.state(1, "a").complete).toBe(false);
    expect(graph.state(1, "a").inProgress).toBe(true);
    const next = graph.begin(1, "a");
    graph.writeInventory(inventory(doc, ["New"]));
    graph.complete(next);
    expect(graph.state(1, "a").complete).toBe(true);
  } finally {
    await store.close();
    await safeRm(root);
  }
});

test("edge diffs preserve retained identity and timestamp, update confidence only, and roll back invalid targets", async () => {
  const store = await open();
  try {
    const source = await add(store, "outside", "Source");
    const target = await add(store, "targets", "Target");
    const edge = {
      targetDocId: target.id,
      edgeType: "Knows",
      confidence: "manual" as const,
    };
    expect(
      (await store.setDocEdges(source.id, [edge], "frontmatter-relation")).ok
    ).toBe(true);
    const db = store.getRawDb();
    db.run("UPDATE doc_edges SET created_at = '2001-01-01 00:00:00'");
    const original = db.query("SELECT * FROM doc_edges").all();
    db.exec(`CREATE TEMP TABLE diff_mutations (operation TEXT);
      CREATE TEMP TRIGGER diff_insert AFTER INSERT ON doc_edges BEGIN INSERT INTO diff_mutations VALUES ('insert'); END;
      CREATE TEMP TRIGGER diff_delete AFTER DELETE ON doc_edges BEGIN INSERT INTO diff_mutations VALUES ('delete'); END;
      CREATE TEMP TRIGGER diff_update AFTER UPDATE ON doc_edges BEGIN INSERT INTO diff_mutations VALUES ('update'); END;`);
    expect(
      (await store.setDocEdges(source.id, [edge, edge], "frontmatter-relation"))
        .ok
    ).toBe(true);
    expect(db.query("SELECT * FROM doc_edges").all()).toEqual(original);
    expect(db.query("SELECT * FROM diff_mutations").all()).toEqual([]);
    expect(
      (
        await store.setDocEdges(
          source.id,
          [{ ...edge, confidence: "configured" }],
          "frontmatter-relation"
        )
      ).ok
    ).toBe(true);
    expect(db.query("SELECT * FROM diff_mutations").all()).toEqual([
      { operation: "update" },
    ]);
    const updated = db.query("SELECT * FROM doc_edges").all();
    expect(updated).toEqual(
      original.map((row) => ({ ...(row as object), confidence: "configured" }))
    );
    expect(
      (
        await store.setDocEdges(
          source.id,
          [{ ...edge, targetDocId: 999999 }],
          "frontmatter-relation"
        )
      ).ok
    ).toBe(false);
    expect(db.query("SELECT * FROM doc_edges").all()).toEqual(updated);
  } finally {
    await store.close();
  }
});
