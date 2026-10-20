import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// node:fs/promises for mkdtemp: Bun has no temp-directory API.
import { mkdtemp } from "node:fs/promises";
// node:os/node:path for tmpdir/join: no Bun equivalents.
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

interface FixtureDoc {
  collection: string;
  relPath: string;
  text: string;
  vector: number[];
  /** Documents sharing a key share one mirror hash (identical content). */
  contentKey?: string;
  /** Link targets get no vector, so only graph expansion can reach them. */
  noVector?: boolean;
}

// "loud" holds the strongest lexical and vector matches, and a byte-identical
// copy of alpha's note. "alpha/a.md" links to a listed and an unlisted note
// that do not match the query, so only graph expansion can reach them.
const DOCS: FixtureDoc[] = [
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
    contentKey: "shared",
  },
  {
    collection: "loud",
    relPath: "copy-of-a.md",
    text: "needle in a long haystack of unrelated words",
    vector: [0.6, 0.8],
    contentKey: "shared",
  },
  {
    collection: "beta",
    relPath: "b.md",
    text: "one needle among many other plain words here",
    vector: [0.6, 0.8],
  },
  {
    collection: "beta",
    relPath: "linked.md",
    text: "an unrelated note about gardens",
    vector: [0, 1],
    noVector: true,
  },
  {
    collection: "loud",
    relPath: "secret.md",
    text: "an unrelated note about harbours",
    vector: [0, 1],
    noVector: true,
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

const mirrorFor = (doc: FixtureDoc, index: number) =>
  `mirror-${doc.contentKey ?? index}`;

const link = (targetCollection: string, target: string, line: number) => ({
  targetRef: target,
  targetRefNorm: target,
  targetCollection,
  linkType: "wiki" as const,
  startLine: line,
  startCol: 1,
  endLine: line,
  endCol: 10,
});

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "collections-allowlist-"));
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
    const mirrorHash = mirrorFor(doc, index);
    const inserted = await adapter.upsertDocument({
      collection: doc.collection,
      relPath: doc.relPath,
      // Docids derive from the first 8 hash characters; keep them unique.
      sourceHash: `${index.toString(16).padStart(8, "0")}-source`,
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
  const source = await adapter.getDocument("alpha", "a.md");
  if (!source.ok || !source.value) throw new Error("missing alpha/a.md");
  const linked = await adapter.setDocLinks(
    source.value.id,
    [link("beta", "linked", 1), link("loud", "secret", 2)],
    "parsed"
  );
  if (!linked.ok) throw new Error(linked.error.message);

  db = new Database(path);
  const created = await createVectorIndexPort(db, {
    model: "collections-allowlist-test",
    dimensions: 2,
  });
  if (!created.ok) throw new Error(created.error.message);
  vectorIndex = created.value;
  for (const [index, doc] of DOCS.entries()) {
    if (doc.noVector) continue;
    expect(
      (
        await vectorIndex.upsertVectors([
          {
            mirrorHash: mirrorFor(doc, index),
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
const collectionsOf = (results: { uri: string }[]) =>
  [
    ...new Set(results.map((result) => result.uri.split("/")[2] ?? "")),
  ].toSorted((a, b) => a.localeCompare(b));

const hybrid = (
  options: Parameters<typeof searchHybrid>[2],
  query = "needle"
) =>
  searchHybrid(
    {
      store: adapter,
      config,
      vectorIndex,
      embedPort,
      expandPort: null,
      rerankPort: null,
    },
    query,
    { noExpand: true, noRerank: true, ...options }
  );

describe("collections allowlist", () => {
  test("BM25 fills the limit from listed collections before the budget", async () => {
    const result = await searchBm25(adapter, "needle", {
      limit: 2,
      collections: ALLOWED,
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(uris(result.value.results)).toEqual([
      "gno://alpha/a.md",
      "gno://beta/b.md",
    ]);
    expect(result.value.meta.collections).toEqual(ALLOWED);
    expect(result.value.meta.collection).toBeUndefined();
  });

  test("vector search fills the limit from listed collections", async () => {
    const result = await searchVectorWithEmbedding(
      { store: adapter, vectorIndex, config, embedPort },
      "needle",
      new Float32Array([1, 0]),
      { limit: 2, collections: ALLOWED }
    );
    if (!result.ok) throw new Error(result.error.message);
    expect(uris(result.value.results)).toEqual([
      "gno://alpha/a.md",
      "gno://beta/b.md",
    ]);
    expect(result.value.meta.collections).toEqual(ALLOWED);
  });

  test("hybrid search fills the limit from listed collections", async () => {
    const result = await hybrid({
      limit: 2,
      collections: ALLOWED,
      noGraph: true,
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(uris(result.value.results)).toEqual([
      "gno://alpha/a.md",
      "gno://beta/b.md",
    ]);
    expect(result.value.meta.collections).toEqual(ALLOWED);
  });

  test("identical content in an unlisted collection hydrates as the listed copy", async () => {
    for (const results of [
      await searchBm25(adapter, "haystack", { collections: ["alpha"] }),
      await hybrid({ collections: ["alpha"], noGraph: true }),
    ]) {
      if (!results.ok) throw new Error(results.error.message);
      expect(uris(results.value.results)).toEqual(["gno://alpha/a.md"]);
    }
  });

  test("graph expansion reaches listed neighbours and never unlisted ones", async () => {
    const listed = await hybrid(
      { limit: 10, collections: ALLOWED },
      "haystack"
    );
    if (!listed.ok) throw new Error(listed.error.message);
    expect(uris(listed.value.results)).toContain("gno://beta/linked.md");
    expect(collectionsOf(listed.value.results)).toEqual(ALLOWED);

    const unscoped = await hybrid({ limit: 20 }, "haystack");
    if (!unscoped.ok) throw new Error(unscoped.error.message);
    expect(uris(unscoped.value.results)).toContain("gno://loud/secret.md");
  });

  test("without collections, results span every collection", async () => {
    const result = await searchBm25(adapter, "needle", { limit: 20 });
    if (!result.ok) throw new Error(result.error.message);
    expect(collectionsOf(result.value.results)).toEqual([
      "alpha",
      "beta",
      "loud",
    ]);
    expect(JSON.stringify(result.value.meta)).not.toContain("collections");
  });
});
