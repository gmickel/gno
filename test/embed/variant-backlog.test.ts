/**
 * Tests for embed backlog processor.
 *
 * @module test/embed/backlog
 */

import { Database } from "bun:sqlite";
import { afterEach, expect, mock, test } from "bun:test";

import type { EmbeddingPort } from "../../src/llm/types";
import type { VectorIndexPort } from "../../src/store/vector";

import { embedBacklog } from "../../src/embed/backlog";
import { embedVariantBatch } from "../../src/embed/variant-retry";
import {
  withBackgroundInference,
  withOwnedInferenceScope,
} from "../../src/llm/inference-scope";
import { migration } from "../../src/store/migrations/028-vector-variants";
import { createVectorIndexPort } from "../../src/store/vector/sqlite-vec";
import { createVectorStatsPort } from "../../src/store/vector/stats";
import { createVectorVariantStore } from "../../src/store/vector/variants";

const variantDatabases: Database[] = [];
afterEach(() => {
  for (const db of variantDatabases.splice(0)) db.close();
});

async function variantFixture(titles = ["Alpha", "Beta", "Alpha"]) {
  const db = new Database(":memory:");
  variantDatabases.push(db);
  db.exec(`CREATE TABLE documents(id INTEGER PRIMARY KEY, mirror_hash TEXT, title TEXT, active INTEGER, collection TEXT);
    CREATE TABLE content_chunks(mirror_hash TEXT, seq INTEGER, text TEXT, PRIMARY KEY(mirror_hash, seq));
    CREATE TABLE content_vectors(mirror_hash TEXT, seq INTEGER, model TEXT, embedding BLOB);
    INSERT INTO content_chunks VALUES ('body', 0, 'Shared body');
    INSERT INTO content_vectors VALUES ('body', 0, 'test-model', X'0000803f');`);
  for (const [index, title] of titles.entries())
    db.run("INSERT INTO documents VALUES (?, 'body', ?, 1, 'docs')", [
      index + 1,
      title,
    ]);
  migration.up(db, "unicode61");
  const store = await createVectorVariantStore(db, {
    model: "test-model",
    modelFingerprint: "actual-test-weights",
    contextSize: 512,
    truncationPolicy: "test-tail-v1",
    dimensions: 3,
  });
  const port = createMockEmbedPort();
  const deps = {
    statsPort: createVectorStatsPort(db),
    embedPort: port,
    vectorIndex: createMockVectorIndex(),
    modelUri: "test-model",
    variantStore: store,
    identityStillCurrent: () => true,
  };
  return { db, store, port, deps };
}

test.each([
  ["Alpha", "Beta", "Alpha"],
  ["Beta", "Alpha", "Alpha"],
])(
  "owner variants preserve title order %j and skip unchanged input",
  async (first, second, third) => {
    const titles = [first, second, third];
    const { db, store, port, deps } = await variantFixture(titles);
    expect(await embedBacklog(deps)).toMatchObject({
      ok: true,
      value: { embedded: 3, errors: 0 },
    });
    expect(
      (port.embedBatch as ReturnType<typeof mock>).mock.calls
    ).toHaveLength(1);
    expect(
      (port.embedBatch as ReturnType<typeof mock>).mock.calls[0]?.[0]
    ).toHaveLength(2);
    expect(store.pending()).toEqual([]);
    expect(store.hasActivated()).toBe(true);
    expect(await embedBacklog(deps)).toMatchObject({
      ok: true,
      value: { embedded: 0 },
    });
    db.run("INSERT INTO documents VALUES (4, 'body', 'Alpha', 1, 'docs')");
    expect(await embedBacklog({ ...deps, batchSize: 1 })).toMatchObject({
      ok: true,
      value: { embedded: 1 },
    });
    expect(
      (port.embedBatch as ReturnType<typeof mock>).mock.calls
    ).toHaveLength(1);
    expect(db.query("SELECT count(*) AS n FROM content_vectors").get()).toEqual(
      { n: 1 }
    );
  }
);

test.each(["title", "content", "delete", "model"])(
  "discards concurrent %s completion and preserves successful current owners",
  async (mutation) => {
    const { db, store, port } = await variantFixture(["Alpha", "Beta"]);
    let identityCurrent = true;
    port.embedBatch = mock(() => {
      if (mutation === "title")
        db.run("UPDATE documents SET title = 'Gamma' WHERE id = 1");
      if (mutation === "content")
        db.run("UPDATE content_chunks SET text = 'Changed body'");
      if (mutation === "delete")
        db.run("UPDATE documents SET active = 0 WHERE id = 1");
      if (mutation === "model") identityCurrent = false;
      return Promise.resolve({
        ok: true as const,
        value: [
          [1, 0, 0],
          [0, 1, 0],
        ],
      });
    });
    const result = await embedVariantBatch({
      store,
      embedPort: port,
      owners: store.pending(),
      identityStillCurrent: () => identityCurrent,
    });
    expect(result.embedded).toBe(
      mutation === "title" || mutation === "delete" ? 1 : 0
    );
    expect(store.pending().length).toBe(
      mutation === "delete" ? 0 : mutation === "title" ? 1 : 2
    );
    expect(store.hasActivated()).toBe(false);
  }
);

test("partial owner batch checkpoints successes and retries only incomplete inputs", async () => {
  const { store, port, deps } = await variantFixture(["Alpha", "Beta"]);
  port.embedBatch = mock(() =>
    Promise.resolve({
      ok: false as const,
      error: {
        code: "INFERENCE_FAILED" as const,
        message: "batch unavailable",
        retryable: true,
      },
    })
  );
  const calls: string[] = [];
  port.embed = mock((input) => {
    calls.push(input);
    return Promise.resolve(
      input.includes("Beta")
        ? {
            ok: false as const,
            error: {
              code: "INFERENCE_FAILED" as const,
              message: "unavailable",
              retryable: true,
            },
          }
        : { ok: true as const, value: [1, 0, 0] }
    );
  });
  expect(await embedBacklog(deps)).toMatchObject({
    ok: true,
    value: { embedded: 1, errors: 1 },
  });
  expect(calls.filter((input) => input.includes("Alpha"))).toHaveLength(1);
  expect(calls.filter((input) => input.includes("Beta"))).toHaveLength(3);
  expect(store.pending().map((owner) => owner.documentId)).toEqual([2]);
  expect(store.hasActivated()).toBe(false);
});

test("production stats select exact runtime partition and retain authority on metadata loss", async () => {
  const { db, port, deps } = await variantFixture(["Alpha", "Beta"]);
  const automatic = {
    ...deps,
    variantStore: undefined,
    identityStillCurrent: undefined,
  };
  const identity = {
    contextSize: 512,
    truncationPolicy: "actual-test-tail",
    modelFingerprint: "actual-test-weights",
    runtimeFingerprint: "actual-test-runtime",
  };
  port.getIdentity = () => identity;
  expect(await embedBacklog(automatic)).toMatchObject({
    ok: true,
    value: { embedded: 2 },
  });
  expect(await embedBacklog(automatic)).toMatchObject({
    ok: true,
    value: { embedded: 0 },
  });
  identity.contextSize = 256;
  expect(await embedBacklog(automatic)).toMatchObject({
    ok: true,
    value: { embedded: 2 },
  });
  expect(db.query("SELECT count(*) AS n FROM vector_variants").get()).toEqual({
    n: 4,
  });
  port.getIdentity = () => undefined;
  expect(await embedBacklog(automatic)).toMatchObject({
    ok: false,
    error: { code: "INVALID_INPUT" },
  });
});

test("collection pass cannot activate incomplete global shadow coverage", async () => {
  const { db, store, deps } = await variantFixture(["Alpha", "Beta"]);
  db.run("UPDATE documents SET collection = 'other' WHERE id = 2");
  expect(
    await embedBacklog({ ...deps, collection: "docs", batchSize: 1 })
  ).toMatchObject({ ok: true, value: { embedded: 1 } });
  expect(store.hasActivated()).toBe(false);
  expect(store.pending().map((owner) => owner.documentId)).toEqual([2]);
});

test("checkpoint failure rolls back vector and owner writes together", async () => {
  const { db, store, port } = await variantFixture(["Alpha", "Beta"]);
  db.exec(`CREATE TRIGGER reject_second_owner BEFORE INSERT ON vector_owners
    WHEN NEW.document_id = 2 BEGIN SELECT RAISE(ABORT, 'checkpoint rejected'); END;`);
  const result = await embedVariantBatch({
    store,
    embedPort: port,
    owners: store.pending(),
    identityStillCurrent: () => true,
  });
  expect(result).toMatchObject({ embedded: 0, errors: 2, contentionErrors: 0 });
  expect(store.pending()).toHaveLength(2);
  expect(db.query("SELECT count(*) AS n FROM vector_variants").get()).toEqual({
    n: 0,
  });
  expect(db.query("SELECT count(*) AS n FROM vector_owners").get()).toEqual({
    n: 0,
  });
});

test("unverified provider retains legacy embedding without promoting shadow coverage", async () => {
  const { db, store, deps } = await variantFixture(["Alpha"]);
  // Legacy stats schema; the fixture deliberately started with only variant-required columns.
  db.exec(
    "ALTER TABLE content_chunks ADD COLUMN created_at TEXT; ALTER TABLE content_vectors ADD COLUMN embed_fingerprint TEXT; ALTER TABLE content_vectors ADD COLUMN embedded_at TEXT"
  );
  const checked = await createVectorIndexPort(db, {
    model: "test-model",
    dimensions: 3,
  });
  if (!checked.ok) throw new Error(checked.error.message);
  const result = await embedBacklog({
    ...deps,
    vectorIndex: checked.value,
    variantStore: undefined,
    identityStillCurrent: undefined,
  });
  expect(result).toMatchObject({ ok: true, value: { embedded: 1 } });
  expect(store.hasActivated()).toBe(false);
  expect(store.pending()).toHaveLength(1);
  expect(db.query("SELECT count(*) AS n FROM vector_variants").get()).toEqual({
    n: 0,
  });
});

test("background owner turns cap at 32, pass failed first page and resume only unfinished work", async () => {
  const { store, deps, port } = await variantFixture(
    Array.from({ length: 70 }, (_, i) => `Title ${i}`)
  );
  const batches: number[] = [];
  let fail = true;
  port.embedBatch = async (texts) => {
    batches.push(texts.length);
    if (fail && texts.some((text) => text.includes("Title 0 |")))
      return {
        ok: false,
        error: {
          code: "INFERENCE_FAILED",
          message: "synthetic failure",
          retryable: true,
        },
      };
    return { ok: true, value: texts.map(() => [1, 2, 3]) };
  };
  expect(
    await withBackgroundInference(() =>
      embedBacklog({ ...deps, batchSize: 1000 })
    )
  ).toMatchObject({ ok: true, value: { embedded: 38, errors: 32 } });
  expect(batches).toEqual([32, 32, 6]);
  expect(store.pending({ limit: 100 })).toHaveLength(32);
  fail = false;
  expect(await withBackgroundInference(() => embedBacklog(deps))).toMatchObject(
    { ok: true, value: { embedded: 32, errors: 0 } }
  );
  expect(batches).toEqual([32, 32, 6, 32]);
  expect(store.pending()).toEqual([]);
  expect(store.isActive()).toBe(true);
});

test("interrupted background turns preserve checkpoints and resume each remaining owner once", async () => {
  const { store, deps, port } = await variantFixture(
    Array.from({ length: 70 }, (_, i) => `Unique ${i}`)
  );
  const controller = new AbortController();
  const failure = await withBackgroundInference(() =>
    withOwnedInferenceScope({ signal: controller.signal }, () =>
      embedBacklog({ ...deps, onProgress: () => controller.abort() })
    )
  ).catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(DOMException);
  expect(store.pending({ limit: 100 })).toHaveLength(38);
  expect((port.embedBatch as ReturnType<typeof mock>).mock.calls).toHaveLength(
    1
  );
  expect(await withBackgroundInference(() => embedBacklog(deps))).toMatchObject(
    { ok: true, value: { embedded: 38, errors: 0 } }
  );
  const calls = (port.embedBatch as ReturnType<typeof mock>).mock.calls;
  expect(calls.map((call) => call[0].length)).toEqual([32, 32, 6]);
  expect(new Set(calls.flatMap((call) => call[0])).size).toBe(70);
  expect(store.pending()).toEqual([]);
});

function createMockEmbedPort() {
  return {
    embedBatch: mock((texts: string[]) =>
      Promise.resolve({
        ok: true,
        value: texts.map(() => [0.1, 0.2, 0.3]),
      })
    ),
    embed: mock(() => Promise.resolve({ ok: true, value: [0.1, 0.2, 0.3] })),
    dimensions: () => 3,
    init: () => Promise.resolve({ ok: true }),
    dispose: () => Promise.resolve(),
    modelUri: "test-model",
  } as unknown as EmbeddingPort;
}

interface MockVectorIndex extends VectorIndexPort {
  _syncCalled: boolean;
}

function createMockVectorIndex(
  opts: { vecDirty?: boolean; syncFails?: boolean } = {}
): MockVectorIndex {
  const index = {
    searchAvailable: true,
    model: "test-model",
    dimensions: 3,
    vecDirty: opts.vecDirty ?? false,
    _syncCalled: false,
    upsertVectors: mock(() => Promise.resolve({ ok: true })),
    deleteVectorsForMirror: mock(() => Promise.resolve({ ok: true })),
    searchNearest: mock(() => Promise.resolve({ ok: true, value: [] })),
    rebuildVecIndex: mock(() => Promise.resolve({ ok: true })),
    syncVecIndex: mock(() => {
      index._syncCalled = true;
      if (opts.syncFails) {
        return Promise.resolve({
          ok: false,
          error: { code: "VEC_SYNC_FAILED", message: "Test sync failure" },
        });
      }
      return Promise.resolve({ ok: true, value: { added: 1, removed: 0 } });
    }),
  };
  return index as unknown as MockVectorIndex;
}

test("zero pending repairs missing materialization without model work or losing authority", async () => {
  const { db, store, port, deps } = await variantFixture();
  await embedBacklog(deps);
  db.exec(`DROP TABLE ${store.tableName}`);
  const repaired = await createVectorVariantStore(db, store.identity);
  expect(repaired.hasActivated()).toBe(true);
  expect(repaired.pending()).toEqual([]);
  const calls = (port.embedBatch as ReturnType<typeof mock>).mock.calls.length;
  expect(await embedBacklog({ ...deps, variantStore: repaired })).toMatchObject(
    { ok: true, value: { embedded: 0 } }
  );
  expect(repaired.isActive()).toBe(true);
  expect(
    db.query(`SELECT count(*) AS n FROM ${store.tableName}`).get()
  ).toEqual({ n: 2 });
  expect((port.embedBatch as ReturnType<typeof mock>).mock.calls.length).toBe(
    calls
  );
});

test("forced current-owner counts and writes stay in the selected partition", async () => {
  const { db, store, port, deps } = await variantFixture();
  await embedBacklog(deps);
  const { countVariantBacklog } = await import("../../src/embed/variant-plan");
  expect(countVariantBacklog(deps)).toBe(0);
  expect(countVariantBacklog({ ...deps, force: true })).toBe(3);
  db.run("UPDATE documents SET collection = 'other' WHERE id = 2");
  expect(
    countVariantBacklog({ ...deps, force: true, collection: "docs" })
  ).toBe(2);
  port.embedBatch = mock(async (texts) => ({
    ok: true as const,
    value: texts.map(() => [0.9, 0.2, 0.1]),
  }));
  expect(await embedBacklog({ ...deps, force: true })).toMatchObject({
    ok: true,
    value: { embedded: 3 },
  });
  const rows = db
    .query<{ embedding: Uint8Array }, []>(
      "SELECT embedding FROM vector_variants"
    )
    .all();
  for (const row of rows)
    expect(
      new Float32Array(row.embedding.buffer, row.embedding.byteOffset, 3)[0]
    ).toBeCloseTo(0.9);
  const indexed = db
    .query<{ embedding: Uint8Array }, []>(
      `SELECT embedding FROM ${store.tableName}`
    )
    .all();
  for (const row of indexed)
    expect(
      new Float32Array(row.embedding.buffer, row.embedding.byteOffset, 3)[0]
    ).toBeCloseTo(0.9);
  expect(db.query("SELECT count(*) AS n FROM content_vectors").get()).toEqual({
    n: 1,
  });
});
