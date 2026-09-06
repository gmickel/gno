import { afterEach, expect, test } from "bun:test";
// Bun has no temporary-directory creation/path API.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SqliteAdapter } from "../../src/store/sqlite/adapter";

import { getEmbeddingFingerprint } from "../../src/embed/fingerprint";
import {
  createVectorVariantStore,
  SELECTED_VECTOR_PARTITION_PREFIX,
} from "../../src/store/vector/variants";
import { safeRm } from "../helpers/cleanup";
import {
  createVariantStatusFixture,
  statusIdentity,
} from "./helpers/variant-status";

const stores: SqliteAdapter[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const directory of directories.splice(0)) await safeRm(directory);
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gno-variant-status-"));
  directories.push(directory);
  const result = await createVariantStatusFixture(
    join(directory, "index.sqlite")
  );
  stores.push(result.store);
  return result;
}

async function coverage(
  store: SqliteAdapter,
  options: { embedModel?: string; embedFingerprint?: string } = {
    embedModel: statusIdentity.model,
  }
) {
  const result = await store.getStatus(options);
  if (!result.ok) throw new Error(result.error.message);
  return {
    backlog: result.value.embeddingBacklog,
    total: result.value.totalChunks,
    collections: result.value.collections.map(
      ({ name, totalChunks, embeddedChunks }) => ({
        name,
        total: totalChunks,
        embedded: embeddedChunks,
      })
    ),
  };
}

test("complete activated owners replace missing/stale legacy vectors without status writes", async () => {
  const { store } = await fixture();
  const db = store.getRawDb();
  const expected = {
    backlog: 0,
    total: 3,
    collections: [
      { name: "archive", total: 2, embedded: 2 },
      { name: "notes", total: 2, embedded: 2 },
    ],
  };
  expect(await coverage(store)).toEqual(expected);
  db.run(
    `INSERT INTO content_vectors(mirror_hash, seq, model, embed_fingerprint, embedding, embedded_at)
    VALUES ('shared', 0, ?, 'stale', ?, '2000-01-01')`,
    [statusIdentity.model, new Uint8Array(8)]
  );
  const changes = db.query("SELECT total_changes() AS count").get();
  db.exec("PRAGMA query_only = ON");
  expect(await coverage(store)).toEqual(expected);
  expect(await coverage(store, {})).toEqual(expected);
  expect(db.query("SELECT total_changes() AS count").get()).toEqual(changes);
});

test("stale epochs retain valid owners but missing/title-changed owners remain pending", async () => {
  const { store, variants } = await fixture();
  const db = store.getRawDb();
  db.run(
    "UPDATE documents SET title = 'Changed' WHERE collection = 'notes' AND rel_path = 'beta.md'"
  );
  expect(variants.isActive()).toBe(false);
  expect((await coverage(store)).backlog).toBe(2);
  expect((await coverage(store)).collections).toEqual([
    { name: "archive", total: 2, embedded: 2 },
    { name: "notes", total: 2, embedded: 0 },
  ]);
  db.run(
    "DELETE FROM vector_owners WHERE document_id = (SELECT id FROM documents WHERE collection = 'archive' AND rel_path = 'alpha.md') AND seq = 0"
  );
  expect((await coverage(store)).backlog).toBe(3);
  expect((await coverage(store)).collections[0]?.embedded).toBe(1);
  db.run(
    "UPDATE documents SET active = 0 WHERE collection = 'notes' AND rel_path = 'beta.md'"
  );
  expect((await coverage(store)).backlog).toBe(1);
  expect((await coverage(store)).collections[1]?.embedded).toBe(2);
});

test("selected verified partition switches ignore old complete coverage and accept new complete coverage", async () => {
  const { store } = await fixture();
  const replacement = await createVectorVariantStore(store.getRawDb(), {
    ...statusIdentity,
    contextSize: 1024,
  });
  // Older ambiguous indexes fail closed until embedding records its actual selection.
  expect((await coverage(store)).backlog).toBe(6);
  replacement.selectForEmbedding();
  const owners = replacement.pending();
  replacement.write([
    { owner: owners[0]!, embedding: new Float32Array([0, 1]) },
  ]);
  expect((await coverage(store)).backlog).toBe(5);
  replacement.write(
    replacement
      .pending()
      .map((owner) => ({ owner, embedding: new Float32Array([0, 1]) }))
  );
  replacement.activate(replacement.epoch());
  expect((await coverage(store)).backlog).toBe(0);
  store
    .getRawDb()
    .run("UPDATE schema_meta SET value = 'missing-partition' WHERE key = ?", [
      SELECTED_VECTOR_PARTITION_PREFIX + statusIdentity.model,
    ]);
  expect((await coverage(store)).backlog).toBe(6);
});

test("model and explicit fingerprint scopes never fall back to unrelated legacy data after activation", async () => {
  const { store } = await fixture();
  for (const [options, pending] of [
    [{ embedModel: "another-model" }, 2],
    [{ embedModel: statusIdentity.model, embedFingerprint: "wrong" }, 6],
    [
      {
        embedModel: statusIdentity.model,
        embedFingerprint: getEmbeddingFingerprint({
          modelUri: statusIdentity.model,
          dimensions: 2,
        }),
      },
      0,
    ],
  ] as const) {
    const result = await store.getStatus(options);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.embeddingBacklog).toBe(pending);
  }
});

test("unselected shadow preserves legacy fallback; verified selection uses exact owner coverage", async () => {
  const { store, variants } = await fixture();
  const db = store.getRawDb();
  db.run(
    "UPDATE vector_partitions SET state = 'shadow', activated_epoch = NULL"
  );
  expect((await coverage(store)).backlog).toBe(2);
  variants.selectForEmbedding();
  expect((await coverage(store)).backlog).toBe(0);
  db.run(
    "UPDATE content_chunks SET text = 'Changed body' WHERE mirror_hash = 'shared' AND seq = 0"
  );
  expect((await coverage(store)).backlog).toBe(3);
});

test("unscoped status accepts any selected model without mixing same-model partitions", async () => {
  const { store, variants } = await fixture();
  variants.selectForEmbedding();
  const other = await createVectorVariantStore(store.getRawDb(), {
    ...statusIdentity,
    model: "other-model",
  });
  other.write(
    other
      .pending()
      .map((owner) => ({ owner, embedding: new Float32Array([0, 1]) }))
  );
  other.activate(other.epoch());
  other.selectForEmbedding();
  expect((await coverage(store, {})).backlog).toBe(0);
  const db = store.getRawDb();
  db.run("DELETE FROM vector_owners WHERE partition_id = ? AND seq = 0", [
    variants.partitionId,
  ]);
  db.run("DELETE FROM vector_owners WHERE partition_id = ? AND seq = 1", [
    other.partitionId,
  ]);
  expect((await coverage(store, {})).backlog).toBe(0);
  expect((await coverage(store)).backlog).toBe(3);
  db.run(
    "DELETE FROM vector_owners WHERE partition_id = ? AND document_id = (SELECT id FROM documents WHERE collection = 'archive' AND rel_path = 'alpha.md')",
    [other.partitionId]
  );
  expect((await coverage(store, {})).backlog).toBe(1);
  db.run(
    "INSERT INTO schema_meta(key, value) VALUES ('vectorXselectedYpartition:unrelated', 'invalid')"
  );
  expect((await coverage(store, {})).backlog).toBe(1);
});
