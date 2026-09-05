import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
// Bun has no directory-creation or OS/path equivalents.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FtsSearchOptions } from "../../src/store/types";

import { eligibleTopKFixture } from "../../evals/fixtures/acceptance/eligible-top-k/fixture";
import { searchBm25 } from "../../src/pipeline/search";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { buildEligibleDocumentQuery } from "../../src/store/sqlite/eligibility";
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

test.each([1, 10, 201, 300])(
  "201-document exhaustive lexical oracle parity K=%i",
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
      expect(result.value.map((row) => row.relPath)).toEqual(expected);
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

test("exhaustive eligible ordering, scopes, exclusions and broad K boundaries", async () => {
  const exhaustive = db
    .query<{ rel_path: string; score: number }, []>(`
    SELECT d.rel_path, bm25(documents_fts, 1.5, 4.0, 1.0) AS score
    FROM documents_fts JOIN documents d ON d.id = documents_fts.rowid
    WHERE documents_fts MATCH 'needle' AND d.active = 1 ORDER BY score
  `)
    .all();
  const cases: {
    options: FtsSearchOptions;
    eligible: (path: string) => boolean;
  }[] = [
    { options: {}, eligible: () => true },
    {
      options: { until: "2021-01-01" },
      eligible: (path) => path !== "scope/target.md",
    },
    { options: { tagsAny: ["noise", "approved"] }, eligible: () => true },
    {
      options: { categories: ["decision"] },
      eligible: (path) => path === "scope/target.md",
    },
    {
      options: { tagsAll: ["approved"], author: "ada", collection: "notes" },
      eligible: (path) => path === "scope/target.md",
    },
    { options: { allowedMirrorHashes: [] }, eligible: () => false },
    {
      options: {
        allowedMirrorHashes: ["eligible-v1-200"],
        relPathPrefix: "scope",
      },
      eligible: (path) => path === "scope/target.md",
    },
    {
      options: {
        allowedMirrorHashes: ["eligible-v1-200"],
        relPathPrefix: "other",
      },
      eligible: () => false,
    },
    {
      options: { exclude: ["noise-"] },
      eligible: (path) => path === "scope/target.md",
    },
    {
      options: { exclude: ["DEUTSCHE"] },
      eligible: (path) => path !== "scope/target.md",
    },
    { options: { since: "not-a-date" }, eligible: () => false },
    { options: { collection: "absent" }, eligible: () => false },
  ];
  for (const { options, eligible } of cases) {
    for (const limit of [1, 10, 201, 300]) {
      const result = await adapter.searchFts("needle", { ...options, limit });
      if (!result.ok) throw new Error(result.error.message);
      expect(
        result.value.map(({ relPath, score }) => ({ rel_path: relPath, score }))
      ).toEqual(
        exhaustive.filter((row) => eligible(row.rel_path)).slice(0, limit)
      );
    }
  }
});

test("public lexical pipeline fills eligible budget before exclusions and scope", async () => {
  for (const limit of [1, 10]) {
    for (const options of [
      { exclude: ["noise-"] },
      {
        retrievalScope: {
          allowedMirrorHashes: ["eligible-v1-200"],
          relPathPrefix: "scope",
        },
      },
    ]) {
      const result = await searchBm25(adapter, "needle", { ...options, limit });
      if (!result.ok) throw new Error(result.error.message);
      expect(result.value.results.map((row) => row.uri)).toEqual([
        "gno://notes/scope/target.md",
      ]);
    }
  }
});

test("selective and broad SQL plans enumerate eligible ranked rows", async () => {
  const evidence = [];
  for (const options of [{ tagsAll: ["approved"] }, {}]) {
    const eligible = buildEligibleDocumentQuery(options);
    const shapes = {
      owner_in: `SELECT rowid, bm25(documents_fts, 1.5, 4.0, 1.0) score FROM documents_fts WHERE documents_fts MATCH ? AND rowid IN (SELECT id FROM (${eligible.sql})) ORDER BY score`,
      owner_exists: `SELECT rowid, bm25(documents_fts, 1.5, 4.0, 1.0) score FROM documents_fts WHERE documents_fts MATCH ? AND EXISTS (SELECT 1 FROM (${eligible.sql}) eligible WHERE eligible.id = documents_fts.rowid) ORDER BY score`,
    };
    for (const [shape, sql] of Object.entries(shapes)) {
      const params = ["needle", ...eligible.params];
      const start = performance.now();
      const rows = db.query(sql).all(...params);
      const elapsedMs = performance.now() - start;
      expect(rows.length).toBe("tagsAll" in options ? 1 : 200);
      evidence.push({
        options,
        shape,
        sql,
        params,
        actualRankedRows: rows.length,
        elapsedMs,
        plan: db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params),
      });
    }
  }
  if (process.env.GNO_ELIGIBILITY_EVIDENCE) {
    await Bun.write(
      process.env.GNO_ELIGIBILITY_EVIDENCE,
      JSON.stringify(evidence, null, 2)
    );
  }
});
