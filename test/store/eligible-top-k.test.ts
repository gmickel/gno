import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
// Bun has no directory-creation or OS/path equivalents.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FtsSearchOptions } from "../../src/store/types";

import { eligibleTopKFixture } from "../../evals/fixtures/acceptance/eligible-top-k/fixture";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

const fixture = eligibleTopKFixture();
const adapter = new SqliteAdapter();
let directory: string;
let db: Database;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "eligible-top-k-"));
  const path = join(directory, "index.sqlite");
  expect((await adapter.open(path, "unicode61")).ok).toBe(true);
  expect(
    (
      await adapter.syncCollections([
        {
          name: "notes",
          path: directory,
          pattern: "**/*",
          include: [],
          exclude: [],
        },
      ])
    ).ok
  ).toBe(true);
  for (const { doc, chunks, tags } of fixture) {
    const inserted = await adapter.upsertDocument({
      collection: doc.collection,
      relPath: doc.relPath,
      sourceHash: doc.sourceHash,
      sourceMime: doc.sourceMime,
      sourceExt: doc.sourceExt,
      sourceSize: doc.sourceSize,
      sourceMtime: doc.sourceMtime,
      title: doc.title ?? undefined,
      mirrorHash: doc.mirrorHash ?? undefined,
      contentType: doc.contentType ?? undefined,
      categories: doc.categories ?? undefined,
      author: doc.author ?? undefined,
    });
    if (!inserted.ok) throw new Error(inserted.error.message);
    expect(
      (
        await adapter.upsertContent(
          doc.mirrorHash!,
          chunks.map((c) => c.text).join("\n")
        )
      ).ok
    ).toBe(true);
    expect(
      (
        await adapter.upsertChunks(
          doc.mirrorHash!,
          chunks.map((chunk) => ({
            ...chunk,
            language: chunk.language ?? undefined,
            tokenCount: chunk.tokenCount ?? undefined,
          }))
        )
      ).ok
    ).toBe(true);
    expect(
      (await adapter.setDocTags(inserted.value.id, tags, "frontmatter")).ok
    ).toBe(true);
    expect((await adapter.rebuildFtsForHash(doc.mirrorHash!)).ok).toBe(true);
    if (!doc.active)
      expect(
        (await adapter.markInactive(doc.collection, [doc.relPath])).ok
      ).toBe(true);
  }
  db = new Database(path, { readonly: true });
});

afterAll(async () => {
  db?.close();
  await adapter.close();
  if (directory) await safeRm(directory);
});

const filters: FtsSearchOptions[] = [
  { tagsAll: ["approved", "release"] },
  { tagsAny: ["approved"] },
  { since: "2026-09-01T00:00:00.000Z" },
  { author: "Ada" },
  { categories: ["release"] },
];

test.each([1, 10])(
  "201-document exhaustive lexical oracle and baseline starvation K=%i",
  async (limit) => {
    expect(
      db
        .query<{ count: number }, []>("SELECT count(*) AS count FROM documents")
        .get()?.count
    ).toBe(201);
    // No candidate LIMIT. Enumerate every match and retain the independently
    // pinned eligible owner; preserve SQLite's BM25 ordering within that set.
    const exhaustive = db
      .query<{ rel_path: string; active: number; score: number }, []>(`
    SELECT d.rel_path, d.active, bm25(documents_fts, 1.5, 4.0, 1.0) AS score
    FROM documents_fts JOIN documents d ON d.id = documents_fts.rowid
    WHERE documents_fts MATCH 'needle'
    ORDER BY score, d.rel_path
  `)
      .all();
    const expected = exhaustive
      .filter((row) => row.active === 1 && row.rel_path === "scope/target.md")
      .slice(0, limit)
      .map((row) => row.rel_path);
    expect(expected).toEqual(["scope/target.md"]);
    for (const options of filters) {
      const result = await adapter.searchFts("needle", { ...options, limit });
      if (!result.ok) throw new Error(result.error.message);
      // Characterization only: fn-148.2 replaces this rejection with parity.
      // The required correct result above must never be changed to an empty list.
      expect(result.value.map((row) => row.relPath)).toEqual([]);
      expect(result.value.map((row) => row.relPath)).not.toEqual(expected);
    }
  }
);

test("path scope, deny/no matches, inactive rows and invalid lexical input", async () => {
  const scoped = await adapter.searchFts("needle", {
    relPathPrefix: "scope/target.md",
    limit: 1,
  });
  if (!scoped.ok) throw new Error(scoped.error.message);
  expect(scoped.value.map((row) => row.relPath)).toEqual(["scope/target.md"]);
  for (const options of [
    { tagsAll: ["absent"] },
    { relPathPrefix: "scop" },
    { relPathPrefix: "scope/noise-199.md" },
  ]) {
    const result = await adapter.searchFts("needle", options);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value).toEqual([]);
  }
  const invalid = await adapter.searchFts('"unterminated', { limit: 1 });
  expect(invalid.ok).toBe(false);
  if (!invalid.ok) expect(invalid.error.code).toBe("INVALID_INPUT");
});

test("scenario corpus hash remains pinned independently of fn-143", async () => {
  const manifest = await Bun.file(
    new URL(
      "../../evals/fixtures/acceptance/eligible-top-k/manifest.json",
      import.meta.url
    )
  ).json();
  expect(
    new Bun.CryptoHasher("sha256").update(JSON.stringify(fixture)).digest("hex")
  ).toBe(manifest.corpusSha256);
});
