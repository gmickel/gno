import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// Bun has no directory-creation or OS/path equivalents.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../../src/config/types";
import type { EmbeddingPort } from "../../src/llm/types";
import type { VectorIndexPort } from "../../src/store/vector/types";

import { searchHybrid } from "../../src/pipeline/hybrid";
import { searchBm25 } from "../../src/pipeline/search";
import { searchVectorWithEmbedding } from "../../src/pipeline/vsearch";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { createVectorIndexPort } from "../../src/store/vector/sqlite-vec";
import { safeRm } from "../helpers/cleanup";

// "loud" holds the strongest lexical and vector matches; a collection
// allowlist must remove them before the limit, not after it.
const DOCS = [
  ...Array.from({ length: 6 }, (_, i) => ({
    collection: "loud",
    relPath: `l${i}.md`,
    text: "needle needle needle needle",
    vector: [1, 0],
  })),
  {
    collection: "alpha",
    relPath: "a.md",
    text: "needle in a long haystack of unrelated words",
    vector: [0.6, 0.8],
  },
  {
    collection: "beta",
    relPath: "b.md",
    text: "one needle among many other plain words here",
    vector: [0.6, 0.8],
  },
];

const adapter = new SqliteAdapter();
const config = {} as Config;
const embedPort: EmbeddingPort = {
  modelUri: "test",
  dimensions: () => 2,
  init: async () => ({ ok: true, value: undefined }),
  dispose: async () => {},
  embed: async () => ({ ok: true, value: [1, 0] }),
  embedBatch: async (texts) => ({ ok: true, value: texts.map(() => [1, 0]) }),
};
let directory: string;
let db: Database;
let vectorIndex: VectorIndexPort;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "multi-collection-"));
  const path = join(directory, "index.sqlite");
  expect((await adapter.open(path, "unicode61")).ok).toBe(true);
  expect(
    (
      await adapter.syncCollections(
        ["loud", "alpha", "beta"].map((name) => ({
          name,
          path: join(directory, name),
          pattern: "**/*",
          include: [],
          exclude: [],
        }))
      )
    ).ok
  ).toBe(true);
  for (const [index, doc] of DOCS.entries()) {
    const mirrorHash = `mirror-${index}`;
    const inserted = await adapter.upsertDocument({
      collection: doc.collection,
      relPath: doc.relPath,
      sourceHash: `source-${index}`,
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: doc.text.length,
      sourceMtime: "2026-10-01T00:00:00.000Z",
      title: doc.relPath,
      mirrorHash,
    });
    if (!inserted.ok) throw new Error(inserted.error.message);
    expect((await adapter.upsertContent(mirrorHash, doc.text)).ok).toBe(true);
    expect(
      (
        await adapter.upsertChunks(mirrorHash, [
          {
            seq: 0,
            pos: 0,
            text: doc.text,
            startLine: 1,
            endLine: 1,
            language: "en",
          },
        ])
      ).ok
    ).toBe(true);
    expect((await adapter.rebuildFtsForHash(mirrorHash)).ok).toBe(true);
  }
  db = new Database(path);
  const created = await createVectorIndexPort(db, {
    model: "multi-collection-test",
    dimensions: 2,
  });
  if (!created.ok) throw new Error(created.error.message);
  vectorIndex = created.value;
  for (const [index, doc] of DOCS.entries()) {
    expect(
      (
        await vectorIndex.upsertVectors([
          {
            mirrorHash: `mirror-${index}`,
            seq: 0,
            model: vectorIndex.model,
            embedFingerprint: "test",
            embedding: new Float32Array(doc.vector),
          },
        ])
      ).ok
    ).toBe(true);
  }
});

afterAll(async () => {
  db?.close();
  await adapter.close();
  if (directory) await safeRm(directory);
});

const ALLOWED = ["alpha", "beta"];
const uris = (results: { uri: string }[]) =>
  results.map((result) => result.uri).toSorted();

const run = {
  bm25: (options: Parameters<typeof searchBm25>[2]) =>
    searchBm25(adapter, "needle", options),
  vector: (options: Parameters<typeof searchVectorWithEmbedding>[3]) =>
    searchVectorWithEmbedding(
      { store: adapter, vectorIndex, config, embedPort },
      "needle",
      new Float32Array([1, 0]),
      options
    ),
  hybrid: (options: Parameters<typeof searchHybrid>[2]) =>
    searchHybrid(
      {
        store: adapter,
        config,
        vectorIndex,
        embedPort,
        expandPort: null,
        rerankPort: null,
      },
      "needle",
      { ...options, noExpand: true, noRerank: true }
    ),
};

describe.each(["bm25", "vector", "hybrid"] as const)(
  "%s collections allowlist",
  (mode) => {
    test("without collections the loud collection fills the limit", async () => {
      const result = await run[mode]({ limit: 2 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.results).toHaveLength(2);
      for (const hit of result.value.results)
        expect(hit.uri.startsWith("gno://loud/")).toBe(true);
      expect(result.value.meta.collections).toBeUndefined();
    });

    test("two collections return only their documents, filtered before the limit", async () => {
      const result = await run[mode]({ limit: 2, collections: ALLOWED });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(uris(result.value.results)).toEqual([
        "gno://alpha/a.md",
        "gno://beta/b.md",
      ]);
      expect(result.value.meta.collections).toEqual(ALLOWED);
    });

    test("intersects with the singular collection filter", async () => {
      const result = await run[mode]({
        limit: 5,
        collection: "alpha",
        collections: ALLOWED,
      });
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(uris(result.value.results)).toEqual(["gno://alpha/a.md"]);
    });

    test("an empty allowlist denies all", async () => {
      const result = await run[mode]({ limit: 5, collections: [] });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.results).toEqual([]);
    });
  }
);
