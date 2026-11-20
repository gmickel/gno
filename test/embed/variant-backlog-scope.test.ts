/**
 * Collection-scoped variant backlog (gno#348): counts and pages are limited to
 * one collection in SQL, and unbound rows are counted without formatting or
 * hashing, with the same results as the previous walk-and-filter algorithm.
 */

import type { Database as DatabaseType } from "bun:sqlite";

import { Database } from "bun:sqlite";
import { afterEach, expect, mock, spyOn, test } from "bun:test";

import type { EmbedBacklogDeps } from "../../src/embed/backlog";
import type { EmbeddingPort } from "../../src/llm/types";
import type { VectorIndexPort } from "../../src/store/vector";
import type { VectorOwnerInput } from "../../src/store/vector/types";

import { embedBacklog } from "../../src/embed/backlog";
import {
  countVariantBacklog,
  variantBacklogPage,
} from "../../src/embed/variant-plan";
import { formatDocForEmbedding } from "../../src/pipeline/contextual";
import { migration } from "../../src/store/migrations/028-vector-variants";
import { migration as runtimeMigration } from "../../src/store/migrations/031-runtime-independent-vectors";
import { createVectorStatsPort } from "../../src/store/vector/stats";
import {
  createVectorVariantStore,
  embeddingInputHash,
  VectorVariantStore,
} from "../../src/store/vector/variants";

const databases: DatabaseType[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const BIG_DOCS = 40;
const identity = {
  model: "test-model",
  modelFingerprint: "actual-test-weights",
  contextSize: 512,
  truncationPolicy: "test-tail-v1",
  dimensions: 3,
};

/**
 * Two collections: `big` is large and never embedded; `small` mixes current,
 * title-changed, mirror-changed, unbound, inactive and other-partition owners,
 * and shares one mirror with `big`.
 */
async function scopeFixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE documents(id INTEGER PRIMARY KEY, mirror_hash TEXT, title TEXT, active INTEGER, collection TEXT);
    CREATE INDEX idx_documents_collection ON documents(collection);
    CREATE TABLE content_chunks(mirror_hash TEXT, seq INTEGER, text TEXT, PRIMARY KEY(mirror_hash, seq));
    CREATE TABLE content_vectors(mirror_hash TEXT, seq INTEGER, model TEXT, embedding BLOB);`);
  const doc = (
    id: number,
    mirror: string,
    title: string,
    collection: string,
    active = 1
  ) =>
    db.run("INSERT INTO documents VALUES (?, ?, ?, ?, ?)", [
      id,
      mirror,
      title,
      active,
      collection,
    ]);
  const chunks = (mirror: string, count: number) => {
    for (let seq = 0; seq < count; seq++)
      db.run("INSERT INTO content_chunks VALUES (?, ?, ?)", [
        mirror,
        seq,
        `${mirror} chunk ${seq}`,
      ]);
  };
  // Interleave ids so neither collection is a contiguous id range.
  for (let i = 0; i < BIG_DOCS; i++) {
    doc(100 + i * 2, `big-${i}`, `Big ${i}`, "big");
    chunks(`big-${i}`, 3);
  }
  for (const [mirror, n] of [
    ["s-current", 2],
    ["s-title", 2],
    ["s-old", 2],
    ["s-new", 3],
    ["shared", 2],
    ["s-inactive", 2],
    ["s-other", 2],
  ] as const)
    chunks(mirror, n);
  doc(101, "s-current", "Current", "small");
  doc(103, "s-title", "Before", "small");
  doc(105, "s-old", "Moved", "small");
  doc(107, "shared", "Shared small", "small");
  doc(109, "s-inactive", "Inactive", "small", 0);
  doc(111, "s-other", "Other partition", "small");
  doc(113, "shared", "Shared big", "big");
  migration.up(db, "unicode61");
  runtimeMigration.up(db, "unicode61");

  const store = await createVectorVariantStore(db, identity);
  const other = await createVectorVariantStore(db, {
    ...identity,
    modelFingerprint: "other-weights",
  });
  const embedding = (i: number) => new Float32Array([1, i, 0]);
  const owned = (documentId: number) =>
    store.pending({ limit: 1000 }).filter((o) => o.documentId === documentId);
  store.write(
    [101, 103, 105]
      .flatMap(owned)
      .map((owner, i) => ({ owner, embedding: embedding(i) }))
  );
  other.write(
    other
      .pending({ limit: 1000 })
      .filter((o) => o.documentId === 111)
      .map((owner, i) => ({ owner, embedding: embedding(i) }))
  );
  // Title change keeps the binding's mirror; mirror change keeps the title.
  db.run("UPDATE documents SET title = 'After' WHERE id = 103");
  db.run("UPDATE documents SET mirror_hash = 's-new' WHERE id = 105");

  const deps: EmbedBacklogDeps = {
    statsPort: createVectorStatsPort(db),
    embedPort: mockEmbedPort(),
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
  return { db, store, deps };
}

function mockEmbedPort(): EmbeddingPort {
  return {
    embedBatch: mock((texts: string[]) =>
      Promise.resolve({ ok: true, value: texts.map(() => [0.1, 0.2, 0.3]) })
    ),
    embed: mock(() => Promise.resolve({ ok: true, value: [0.1, 0.2, 0.3] })),
    dimensions: () => 3,
    init: () => Promise.resolve({ ok: true }),
    dispose: () => Promise.resolve(),
    modelUri: "test-model",
  } as unknown as EmbeddingPort;
}

// ─── Oracle: the algorithm before gno#348, copied verbatim in behaviour ──────

function oracleInput(
  row: {
    documentId: number;
    mirrorHash: string;
    seq: number;
    text: string;
    title: string | null;
  },
  model: string
): VectorOwnerInput {
  const formattedInput = formatDocForEmbedding(
    row.text,
    row.title ?? undefined,
    model
  );
  return {
    documentId: row.documentId,
    mirrorHash: row.mirrorHash,
    seq: row.seq,
    formattedInput,
    inputHash: embeddingInputHash(formattedInput),
  };
}

/** Old `pending()`: whole-index walk, per-row binding lookup. */
function oraclePending(
  db: DatabaseType,
  store: VectorVariantStore,
  limit: number,
  after?: { documentId: number; seq: number }
): VectorOwnerInput[] {
  const rows = db
    .query<
      {
        documentId: number;
        mirrorHash: string;
        seq: number;
        text: string;
        title: string | null;
      },
      [number, number, number]
    >(`
      SELECT d.id AS documentId, d.mirror_hash AS mirrorHash, c.seq, c.text, d.title
      FROM documents d JOIN content_chunks c ON c.mirror_hash = d.mirror_hash
      WHERE d.active = 1 AND (d.id > ? OR (d.id = ? AND c.seq > ?)) ORDER BY d.id, c.seq
    `)
    .all(after?.documentId ?? -1, after?.documentId ?? -1, after?.seq ?? -1);
  const pending: VectorOwnerInput[] = [];
  for (const row of rows) {
    const input = oracleInput(row, store.identity.model);
    const binding = db
      .query<
        { input_hash: string; mirror_hash: string },
        [number, number, string]
      >(`
        SELECT v.input_hash, o.mirror_hash FROM vector_owners o
        JOIN vector_variants v ON v.variant_id = o.variant_id AND v.partition_id = o.partition_id
        WHERE o.document_id = ? AND o.seq = ? AND o.partition_id = ?
      `)
      .get(input.documentId, input.seq, store.partitionId);
    if (
      binding?.input_hash !== input.inputHash ||
      binding.mirror_hash !== input.mirrorHash
    )
      pending.push(input);
    if (pending.length === limit) break;
  }
  return pending;
}

function inCollection(
  db: DatabaseType,
  documentId: number,
  collection?: string
): boolean {
  return (
    !collection ||
    !!db
      .query(
        "SELECT 1 FROM documents WHERE id = ? AND collection = ? AND active = 1"
      )
      .get(documentId, collection)
  );
}

/** Old pass: page the whole index, then filter each page by collection. */
function oracleOwners(
  db: DatabaseType,
  store: VectorVariantStore,
  options: { collection?: string; force?: boolean }
): VectorOwnerInput[] {
  const all: VectorOwnerInput[] = [];
  let after: { documentId: number; seq: number } | undefined;
  while (true) {
    const page = options.force
      ? db
          .query<
            { documentId: number; seq: number },
            [number, number, number]
          >(`
          SELECT d.id AS documentId, c.seq FROM documents d
          JOIN content_chunks c ON c.mirror_hash = d.mirror_hash
          WHERE d.active = 1 AND (d.id > ? OR (d.id = ? AND c.seq > ?))
          ORDER BY d.id, c.seq LIMIT 5
        `)
          .all(
            after?.documentId ?? -1,
            after?.documentId ?? -1,
            after?.seq ?? -1
          )
          .flatMap((row) => {
            const owner = store.current(row.documentId, row.seq);
            return owner ? [owner] : [];
          })
      : oraclePending(db, store, 5, after);
    if (!page.length) return all;
    all.push(
      ...page.filter((o) => inCollection(db, o.documentId, options.collection))
    );
    const last = page.at(-1)!;
    after = { documentId: last.documentId, seq: last.seq };
  }
}

function pagedOwners(
  deps: EmbedBacklogDeps,
  store: VectorVariantStore,
  limit: number
): VectorOwnerInput[] {
  const all: VectorOwnerInput[] = [];
  let after: { documentId: number; seq: number } | undefined;
  while (true) {
    const page = variantBacklogPage(deps, store, limit, after);
    if (!page.length) return all;
    all.push(...page);
    const last = page.at(-1)!;
    after = { documentId: last.documentId, seq: last.seq };
  }
}

const scopes = [
  { collection: "small" },
  { collection: "big" },
  { collection: "missing" },
  {},
  { collection: "small", force: true },
  { collection: "big", force: true },
  { force: true },
];

test.each(scopes)(
  "count and pages match the walk-and-filter oracle for %j",
  async (scope) => {
    const { db, store, deps } = await scopeFixture();
    const expected = oracleOwners(db, store, scope);
    const scoped = { ...deps, ...scope };
    expect(countVariantBacklog(scoped)).toBe(expected.length);
    for (const limit of [1, 2, 7, 1000])
      expect(pagedOwners(scoped, store, limit)).toEqual(expected);
  }
);

test("small collection backlog ignores the large unembedded collection", async () => {
  const { store, deps } = await scopeFixture();
  const owners = pagedOwners({ ...deps, collection: "small" }, store, 32);
  // Title changed (2), mirror changed (3), shared unbound (2), other partition (2).
  expect(owners.map((o) => `${o.documentId}:${o.seq}`)).toEqual([
    "103:0",
    "103:1",
    "105:0",
    "105:1",
    "105:2",
    "107:0",
    "107:1",
    "111:0",
    "111:1",
  ]);
  expect(countVariantBacklog({ ...deps, collection: "small" })).toBe(9);
  expect(countVariantBacklog({ ...deps, collection: "big" })).toBe(
    BIG_DOCS * 3 + 2
  );
});

test("unbound rows count as pending without formatting or hashing", async () => {
  const { store, deps } = await scopeFixture();
  const hashed = spyOn(
    VectorVariantStore.prototype as unknown as {
      input: (row: unknown) => VectorOwnerInput;
    },
    "input"
  );
  try {
    // Only rows bound with a matching mirror need the hash: 101 and 103.
    expect(countVariantBacklog(deps)).toBe(BIG_DOCS * 3 + 2 + 9);
    expect(hashed).toHaveBeenCalledTimes(4);
    hashed.mockClear();
    expect(countVariantBacklog({ ...deps, collection: "big" })).toBe(
      BIG_DOCS * 3 + 2
    );
    expect(hashed).toHaveBeenCalledTimes(0);
    hashed.mockClear();
    expect(store.hasPending()).toBe(true);
    expect(hashed).toHaveBeenCalledTimes(0);
  } finally {
    hashed.mockRestore();
  }
});

test("hasPending agrees with pending once only bound rows remain", async () => {
  const { db, store } = await scopeFixture();
  store.write(
    store
      .pending({ limit: 1000 })
      .map((owner, i) => ({ owner, embedding: new Float32Array([0, i, 1]) }))
  );
  expect(store.pending({ limit: 1 })).toEqual([]);
  expect(store.hasPending()).toBe(false);
  expect(store.countPending()).toBe(0);
  db.run("UPDATE documents SET title = 'Renamed' WHERE id = 101");
  expect(store.hasPending()).toBe(true);
  expect(store.hasPending({ collection: "small" })).toBe(true);
  expect(store.hasPending({ collection: "big" })).toBe(false);
  expect(store.countPending({ collection: "small" })).toBe(2);
  expect(oraclePending(db, store, 1000).map((o) => o.documentId)).toEqual([
    101, 101,
  ]);
});

test("collection pass embeds only that collection and leaves global coverage pending", async () => {
  const { db, store, deps } = await scopeFixture();
  const before = oracleOwners(db, store, {});
  const result = await embedBacklog({
    ...deps,
    collection: "small",
    batchSize: 4,
  });
  expect(result).toMatchObject({ ok: true, value: { embedded: 9, errors: 0 } });
  const texts = (
    deps.embedPort.embedBatch as ReturnType<typeof mock>
  ).mock.calls.flatMap((call) => call[0] as string[]);
  expect(texts.some((text) => text.includes("big-"))).toBe(false);
  expect(countVariantBacklog({ ...deps, collection: "small" })).toBe(0);
  expect(oracleOwners(db, store, {})).toEqual(
    before.filter((o) => !inCollection(db, o.documentId, "small"))
  );
  expect(store.hasActivated()).toBe(false);
});
