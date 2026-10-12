/**
 * BM25 snippets come from stored chunks of the returned rows (fn-220 R6):
 * ranking matches the FTS5 snippet()-era query exactly, and the snippet,
 * its highlights and its line range name the chunk it came from.
 *
 * @module test/pipeline/search-snippet-parity
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChunkInput } from "../../src/store/types";

import {
  chunkTermPresence,
  createSnippetTerms,
  pickSnippetSeq,
  presentTermIds,
  renderChunkSnippet,
  snippetTermWeights,
} from "../../src/pipeline/query-snippet";
import { searchBm25 } from "../../src/pipeline/search";
import { SqliteAdapter } from "../../src/store";
import { safeRm } from "../helpers/cleanup";

const filler = (topic: string, lines: number): string[] =>
  Array.from(
    { length: lines },
    (_, index) => `Line ${index} about ${topic} and unrelated filler words.`
  );

/** Each doc is a list of chunks; each chunk is a list of lines. */
const DOCS: Record<string, string[][]> = {
  "ladder.md": [
    ["# Retrieval notes", ...filler("gardening", 6)],
    filler("cooking", 8),
    [
      "How does the retrieval ladder pick a search mode for a question?",
      "It starts with a fast hybrid search and widens when that misses.",
      ...filler("cooking", 4),
    ],
  ],
  "collections.md": [
    [
      "# Collections",
      "What is the best way to set up a new collection in gno?",
      "To set up a new collection in gno, add a folder and run update.",
      "The best way is one collection per vault space.",
      ...filler("weather", 4),
    ],
  ],
  "embedding.md": [
    filler("travel", 8),
    [
      "Configuration of the embedding model happens per collection.",
      "How do I configure the embedding model for a collection?",
      ...filler("travel", 4),
    ],
  ],
  "slow.md": [
    [
      "# Why search is slow",
      "Why is my search slow on a large index?",
      "A large index makes search slow when snippets scan every document.",
      ...filler("music", 5),
    ],
    filler("search index notes", 6),
  ],
  "pets.md": [filler("gardening", 6), ["A cat sleeps on the porch."]],
  "overview.md": [
    filler("weather", 6),
    ["ÜBERBLICK der Architektur und ihrer Teile."],
  ],
  "mixed.md": [
    [
      "Why does my retrieval ladder pick a slow search mode on a large index?",
      "What is the best way to set up a new collection in gno for embedding?",
      "How do I configure the model?",
    ],
  ],
};

const QUERIES = [
  "how does the retrieval ladder pick a search mode",
  "what is the best way to set up a new collection in gno",
  "why is my search slow on a large index",
  "how do I configure the embedding model for a collection",
  "embedding model",
  "search",
];

const toMatch = (query: string): string =>
  query
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^\p{L}\p{N}'_]/gu, ""))
    .filter(Boolean)
    .map((token) => `"${token}"*`)
    .join(" AND ");

/** The ranking query as it ran with snippet() inside the CTE (2.11.0). */
const SNIPPET_ERA_SQL = `
  WITH fts_matches AS (
    SELECT rowid,
      snippet(documents_fts, 2, '<mark>', '</mark>', '...', 32) as snippet,
      bm25(documents_fts, 1.5, 4.0, 1.0) as score
    FROM documents_fts WHERE documents_fts MATCH ?
    ORDER BY score LIMIT ?
  )
  SELECT d.uri, fm.score FROM fts_matches fm
  JOIN documents d ON d.id = fm.rowid AND d.active = 1
  ORDER BY fm.score LIMIT ?`;

const chunkRanges = new Map<string, { startLine: number; endLine: number }[]>();

describe("BM25 chunk snippets", () => {
  let adapter: SqliteAdapter;
  let testDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "gno-snippet-parity-"));
    adapter = new SqliteAdapter();
    const opened = await adapter.open(
      join(testDir, "index.sqlite"),
      "snowball english"
    );
    expect(opened.ok).toBe(true);
    await adapter.syncCollections([
      {
        name: "notes",
        path: testDir,
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ]);
    for (const [relPath, chunkLines] of Object.entries(DOCS)) {
      const markdown = chunkLines.map((lines) => lines.join("\n")).join("\n");
      const mirrorHash = new Bun.CryptoHasher("sha256")
        .update(markdown)
        .digest("hex");
      let line = 1;
      let pos = 0;
      const chunks: ChunkInput[] = chunkLines.map((lines, seq) => {
        const text = lines.join("\n");
        const chunk = {
          seq,
          pos,
          text,
          startLine: line,
          endLine: line + lines.length - 1,
          tokenCount: Math.ceil(text.length / 4),
        };
        line += lines.length;
        pos += text.length + 1;
        return chunk;
      });
      chunkRanges.set(
        `gno://notes/${relPath}`,
        chunks.map(({ startLine, endLine }) => ({ startLine, endLine }))
      );
      await adapter.upsertDocument({
        collection: "notes",
        relPath,
        sourceHash: mirrorHash,
        sourceMime: "text/markdown",
        sourceExt: ".md",
        sourceMtime: "2026-01-01T00:00:00Z",
        sourceSize: markdown.length,
        mirrorHash,
        title: relPath,
      });
      await adapter.upsertContent(mirrorHash, markdown);
      await adapter.upsertChunks(mirrorHash, chunks);
      await adapter.syncDocumentFts("notes", relPath);
    }
  });

  afterAll(async () => {
    await adapter.close();
    await safeRm(testDir);
  });

  test("order and scores match the snippet()-era ranking query", async () => {
    const db = adapter.getRawDb();
    for (const query of QUERIES) {
      const before = db
        .query<{ uri: string; score: number }, [string, number, number]>(
          SNIPPET_ERA_SQL
        )
        .all(toMatch(query), 20, 20);
      expect(before.length).toBeGreaterThan(1);

      const fts = await adapter.searchFts(query, { limit: 20 });
      expect(fts.ok).toBe(true);
      if (!fts.ok) return;
      expect(fts.value.map(({ uri, score }) => ({ uri, score }))).toEqual(
        before
      );

      const searched = await searchBm25(adapter, query, { limit: 20 });
      expect(searched.ok).toBe(true);
      if (!searched.ok) return;
      const raw = before.map((row) => row.score);
      const [best, worst] = [Math.min(...raw), Math.max(...raw)];
      expect(
        searched.value.results.map(({ uri, score }) => ({ uri, score }))
      ).toEqual(
        before.map((row) => ({
          uri: row.uri,
          score: worst === best ? 1 : (worst - row.score) / (worst - best),
        }))
      );
    }
  });

  test("snippet and snippetRange come from the matching chunk", async () => {
    const result = await searchBm25(adapter, "retrieval ladder");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hit = result.value.results.find((entry) =>
      entry.uri.endsWith("ladder.md")
    );
    const thirdChunk = chunkRanges.get("gno://notes/ladder.md")?.[2];
    expect(thirdChunk).toBeDefined();
    expect(hit?.snippetRange).toEqual(thirdChunk);
    expect(hit?.line).toBe(thirdChunk?.startLine);
    expect(hit?.snippet).toContain(
      "the <mark>retrieval</mark> <mark>ladder</mark> pick"
    );
  });

  test("highlights stemmed forms of the query terms", async () => {
    const result = await searchBm25(adapter, "configure embedding -cooking");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [hit] = result.value.results;
    expect(hit?.uri).toBe("gno://notes/embedding.md");
    expect(hit?.snippetRange).toEqual(
      chunkRanges.get("gno://notes/embedding.md")?.[1]
    );
    expect(hit?.snippet).toContain("<mark>Configuration</mark>");
    expect(hit?.snippet).toContain("<mark>configure</mark>");
    expect(hit?.snippet).toContain("<mark>embedding</mark>");
    expect(
      result.value.results.some((entry) => entry.uri.endsWith("ladder.md"))
    ).toBe(false);
  });

  test("short plurals and upper-case non-ASCII pick the matching chunk", async () => {
    for (const [query, uri, highlight] of [
      ["cats", "gno://notes/pets.md", "<mark>cat</mark>"],
      ["überblick", "gno://notes/overview.md", "<mark>ÜBERBLICK</mark>"],
    ] as const) {
      const result = await searchBm25(adapter, query);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const hit = result.value.results.find((entry) => entry.uri === uri);
      expect(hit?.snippetRange).toEqual(chunkRanges.get(uri)?.[1]);
      expect(hit?.snippet).toContain(highlight);
    }
  });

  test("--line-numbers and --full keep raw text without markers", async () => {
    for (const options of [{ lineNumbers: true }, { full: true }]) {
      const result = await searchBm25(adapter, "retrieval ladder", options);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.results[0]?.snippet).not.toContain("<mark>");
    }
  });
});

describe("chunk snippet helpers", () => {
  const termSet = (seq: number, text: string, query: string) => {
    const terms = createSnippetTerms(query);
    if (!terms) throw new Error("expected positive terms");
    return {
      seq,
      terms: presentTermIds(chunkTermPresence(text, terms), terms),
    };
  };

  test("windows long chunks around the hits with ellipses", () => {
    const words = Array.from({ length: 100 }, (_, index) => `w${index}`);
    words[60] = "needle";
    const terms = createSnippetTerms("needle");
    if (!terms) throw new Error("expected positive terms");
    const text = renderChunkSnippet(words.join(" "), terms, new Map());
    expect(text.startsWith("...")).toBe(true);
    expect(text.endsWith("...")).toBe(true);
    expect(text).toContain("<mark>needle</mark>");
    expect(text.split(" ").length).toBe(32);
  });

  test("prefers the chunk covering rarer terms, lowest seq on ties", () => {
    const sets = [
      termSet(0, "alpha alpha alpha alpha", "alpha beta"),
      termSet(2, "beta alpha", "alpha beta"),
      termSet(1, "alpha beta", "alpha beta"),
      termSet(3, "gamma", "alpha beta"),
    ];
    expect(pickSnippetSeq(sets, snippetTermWeights(sets))).toBe(1);
  });

  test("never matches negated terms", () => {
    const terms = createSnippetTerms('alpha -beta -"gamma delta"');
    expect(terms?.prefixes).toEqual(["alpha"]);
    if (!terms) return;
    expect(renderChunkSnippet("alpha beta gamma", terms, new Map())).toBe(
      "<mark>alpha</mark> beta gamma"
    );
    expect(createSnippetTerms('-plain -"two words"')).toBeNull();
  });
});
