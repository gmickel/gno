import { afterEach, beforeEach, expect, mock, test } from "bun:test";
// Bun has no temporary-directory creation, OS temp path, or path-join APIs.
import { mkdir, mkdtemp, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Collection } from "../../src/config/types";
import type { StoreResult } from "../../src/store/types";

import { DEFAULT_CHUNKING_PARAMS } from "../../src/config/chunking";
import { hasContentMutation } from "../../src/core/mutation-generations";
import { defaultChunker } from "../../src/ingestion/chunker";
import { prepareChunking } from "../../src/ingestion/chunking";
import { SyncService } from "../../src/ingestion/sync";
import { withContentTypeRules } from "../../src/ingestion/sync-options";
import { searchBm25 } from "../../src/pipeline/search";
import { createGnoClient } from "../../src/sdk/client";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { createVectorVariantStore } from "../../src/store/vector/variants";
import { safeRm } from "../helpers/cleanup";

const custom = { maxTokens: 64, overlapPercent: 0 };
const markdown = `# Research evidence\n\n${Array.from(
  { length: 60 },
  (_, i) =>
    `## Finding ${i}\n\nTyped retrieval boundaries preserve research evidence. ${"A method needs its context. ".repeat(8)}`
).join("\n\n")}\n`;
let root: string;
let store: SqliteAdapter;
let collection: Collection;

function value<T>(result: StoreResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gno-configurable-chunks-"));
  const path = join(root, "notes");
  await mkdir(path);
  collection = {
    name: "notes",
    path,
    pattern: "**/*",
    include: [],
    exclude: [],
  };
  store = new SqliteAdapter();
  value(await store.open(join(root, "index.sqlite"), "porter"));
  value(await store.syncCollections([collection]));
});

afterEach(async () => {
  await store.close();
  await safeRm(root);
});

test("legacy default sync never invokes chunking or rewrites source metadata", async () => {
  await Bun.write(join(collection.path, "research.md"), markdown);
  const chunk = mock(defaultChunker.chunk.bind(defaultChunker));
  const service = new SyncService(undefined, { chunk });
  await service.syncCollection(collection, store);
  const db = store.getRawDb();
  db.exec("DELETE FROM schema_meta WHERE key GLOB 'chunking_mirror_v1:*'");
  const before = db.query("SELECT * FROM documents").all();
  const chunks = db.query("SELECT * FROM content_chunks").all();
  chunk.mockClear();
  const first = await service.syncCollection(collection, store);
  const second = await service.syncCollection(collection, store, {
    chunking: DEFAULT_CHUNKING_PARAMS,
  });
  expect(first.filesUnchanged).toBe(1);
  expect(second.filesUnchanged).toBe(1);
  expect(chunk).toHaveBeenCalledTimes(0);
  expect(first.rechunkedMirrors).toBeUndefined();
  expect(second.rechunkedMirrors).toBeUndefined();
  expect(db.query("SELECT * FROM documents").all()).toEqual(before);
  expect(db.query("SELECT * FROM content_chunks").all()).toEqual(chunks);
  expect(
    db
      .query(
        "SELECT value FROM schema_meta WHERE key GLOB 'chunking_mirror_v1:*'"
      )
      .get()
  ).toBeNull();
  expect(value(await store.getStatus({ chunking: {} })).chunking?.state).toBe(
    "legacy-default"
  );
});

test("policy changes rechunk shared cached content and targeted reset restores defaults", async () => {
  await Bun.write(join(collection.path, "a.md"), markdown);
  await Bun.write(join(collection.path, "b.md"), markdown);
  const service = new SyncService();
  await service.syncAll([collection], store);
  const doc = value(await store.getDocument(collection.name, "a.md"));
  if (!doc?.mirrorHash) throw new Error("Expected indexed document");
  const defaultChunks = value(await store.getChunks(doc.mirrorHash));
  const documents = store
    .getRawDb()
    .query("SELECT * FROM documents ORDER BY id")
    .all();
  expect(
    value(await store.getStatus({ chunking: custom })).chunking
  ).toMatchObject({
    applied: DEFAULT_CHUNKING_PARAMS,
    state: "pending",
    pendingDocuments: 2,
    pendingMirrors: 1,
  });

  const result = await service.syncPaths(collection, store, ["a.md"], {
    chunking: custom,
  });
  expect(result.rechunkedMirrors).toBe(1);
  expect(result.filesUnchanged).toBe(1);
  expect(hasContentMutation(result)).toBe(true);
  const changed = value(await store.getChunks(doc.mirrorHash));
  expect(changed.length).toBeGreaterThan(defaultChunks.length);
  expect(
    value(await store.getStatus({ chunking: custom })).chunking
  ).toMatchObject({
    applied: custom,
    state: "current",
    pendingDocuments: 0,
    pendingMirrors: 0,
  });
  const repeated = await service.syncAll([collection], store, {
    chunking: custom,
  });
  expect(repeated.rechunkedMirrors).toBeUndefined();
  expect(value(await store.getChunks(doc.mirrorHash))).toEqual(changed);
  expect(
    store.getRawDb().query("SELECT * FROM documents ORDER BY id").all()
  ).toEqual(documents);

  const reverted = await service.syncPaths(collection, store, ["b.md"]);
  expect(reverted.rechunkedMirrors).toBe(1);
  const comparable = (chunks: typeof defaultChunks) =>
    chunks.map(({ createdAt: _time, ...rest }) => rest);
  expect(comparable(value(await store.getChunks(doc.mirrorHash)))).toEqual(
    comparable(defaultChunks)
  );
  expect(
    value(await searchBm25(store, "research evidence", {})).results
  ).toHaveLength(2);
});

test("cached rechunking needs no original source reads and retains code provenance", async () => {
  const source = Array.from(
    { length: 12 },
    (_, i) =>
      `export function finding${i}() {\n${"  const evidence = 'retained';\n".repeat(35)}  return evidence;\n}`
  ).join("\n\n");
  await Bun.write(join(collection.path, "research.ts"), source);
  await new SyncService().syncCollection(collection, store);
  const doc = value(await store.getDocument(collection.name, "research.ts"));
  if (!doc?.mirrorHash) throw new Error("Expected code document");
  const canonical = value(await store.getContent(doc.mirrorHash));
  if (canonical === null) throw new Error("Expected cached content");
  await rename(collection.path, join(root, "unavailable"));
  const result = await prepareChunking(store, defaultChunker, {
    chunking: custom,
  });
  expect(result.rechunkedMirrors).toBe(1);
  const expected = defaultChunker.chunk(
    canonical,
    custom,
    doc.languageHint ?? undefined,
    "research.ts"
  );
  expect(
    value(await store.getChunks(doc.mirrorHash)).map((chunk) => chunk.text)
  ).toEqual(expected.map((chunk) => chunk.text));
  expect(
    value(await store.getDocument(collection.name, "research.ts"))
  ).toEqual(doc);
});

test("partial cached rebuild remains mixed and retries only unfinished mirrors", async () => {
  await Bun.write(join(collection.path, "first.md"), markdown);
  await Bun.write(join(collection.path, "second.md"), `# Second\n${markdown}`);
  await new SyncService().syncCollection(collection, store);
  let calls = 0;
  const failing = {
    chunk: (...args: Parameters<typeof defaultChunker.chunk>) => {
      calls += 1;
      if (calls === 2) throw new Error("injected chunk failure");
      return defaultChunker.chunk(...args);
    },
  };
  const failure = await prepareChunking(store, failing, {
    chunking: custom,
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(
    value(await store.getStatus({ chunking: custom })).chunking
  ).toMatchObject({
    state: "mixed",
    applied: null,
    pendingDocuments: 1,
    pendingMirrors: 1,
  });
  expect(
    (await prepareChunking(store, defaultChunker, { chunking: custom }))
      .rechunkedMirrors
  ).toBe(1);
  expect(
    value(await store.getStatus({ chunking: custom })).chunking?.state
  ).toBe("current");
});

test("unchanged JSONL records and empty Markdown adopt the same policy", async () => {
  collection.recordAdapters = { jsonl: {} };
  await Bun.write(
    join(collection.path, "records.jsonl"),
    `${JSON.stringify({ id: "finding", title: "Finding", text: markdown })}\n`
  );
  await Bun.write(join(collection.path, "empty.md"), "");
  const service = new SyncService();
  await service.syncCollection(collection, store);
  const records = value(
    await store.listRecordDocuments(collection.name, "records.jsonl")
  );
  expect(records).toHaveLength(1);
  const mirrorHash = records[0]?.mirrorHash;
  if (!mirrorHash) throw new Error("Expected record mirror");
  const before = value(await store.getChunks(mirrorHash)).length;
  const result = await service.syncCollection(collection, store, {
    chunking: custom,
  });
  expect(result.rechunkedMirrors).toBe(2);
  expect(value(await store.getChunks(mirrorHash)).length).toBeGreaterThan(
    before
  );
  expect(
    value(await store.getStatus({ chunking: custom })).chunking?.pendingMirrors
  ).toBe(0);
  expect(
    (await service.syncCollection(collection, store, { chunking: custom }))
      .rechunkedMirrors
  ).toBeUndefined();
});

test("active variant ownership disappears for changed chunks and survives a repeat", async () => {
  await Bun.write(join(collection.path, "research.md"), markdown);
  const service = new SyncService();
  await service.syncCollection(collection, store);
  const variants = await createVectorVariantStore(store.getRawDb(), {
    model: "test-embed",
    modelFingerprint: "test-weights",
    contextSize: 512,
    truncationPolicy: "truncate-tail-v1",
    dimensions: 2,
  });
  const oldIds = variants.write(
    variants
      .pending()
      .map((owner) => ({ owner, embedding: new Float32Array([1, 0]) }))
  );
  variants.activate(variants.epoch());
  expect(variants.pending()).toHaveLength(0);
  await service.syncCollection(collection, store);
  expect(variants.pending()).toHaveLength(0);
  expect(oldIds.some((id) => variants.owners(id).length > 0)).toBe(true);
  await service.syncCollection(collection, store, { chunking: custom });
  expect(oldIds.every((id) => variants.owners(id).length === 0)).toBe(true);
  expect(variants.pending().length).toBeGreaterThan(oldIds.length);
  variants.write(
    variants
      .pending()
      .map((owner) => ({ owner, embedding: new Float32Array([1, 0]) }))
  );
  variants.activate(variants.epoch());
  const before = store
    .getRawDb()
    .query("SELECT * FROM vector_owners ORDER BY document_id, seq")
    .all();
  await service.syncCollection(collection, store, { chunking: custom });
  expect(
    store
      .getRawDb()
      .query("SELECT * FROM vector_owners ORDER BY document_id, seq")
      .all()
  ).toEqual(before);
  expect(variants.pending()).toHaveLength(0);
});

test("SDK configuration reaches ingestion and status without CLI overrides", async () => {
  await Bun.write(join(collection.path, "research.md"), markdown);
  const client = await createGnoClient({
    dbPath: join(root, "sdk.sqlite"),
    config: {
      version: "1.0",
      ftsTokenizer: "porter",
      collections: [collection],
      contexts: [],
      chunking: custom,
    },
    downloadPolicy: { offline: true, allowDownload: false },
  });
  try {
    await client.update();
    expect((await client.status()).chunking).toMatchObject({
      configured: custom,
      applied: custom,
      state: "current",
      pendingMirrors: 0,
    });
  } finally {
    await client.close();
  }
  expect(
    withContentTypeRules({}, { chunking: { maxTokens: 256 } }).chunking
  ).toEqual({ maxTokens: 256 });
});
