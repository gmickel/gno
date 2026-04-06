/**
 * Focused BM25 lexical regression tests.
 *
 * These intentionally protect edge cases that have regressed in FTS-backed
 * search systems: hyphenated compounds, underscore-heavy identifiers, ranking
 * by title/path vs body, collection filtering, and malformed lexical input.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChunkInput } from "../../src/store/types";

import { SqliteAdapter } from "../../src/store";
import { safeRm } from "../helpers/cleanup";

describe("FTS lexical regressions", () => {
  let adapter: SqliteAdapter;
  let testDir: string;
  let dbPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "gno-fts-lexical-"));
    dbPath = join(testDir, "test.sqlite");
    adapter = new SqliteAdapter();
    await adapter.open(dbPath, "unicode61");

    await adapter.syncCollections([
      {
        name: "notes",
        path: "/notes",
        pattern: "**/*",
        include: [],
        exclude: [],
      },
      {
        name: "docs",
        path: "/docs",
        pattern: "**/*",
        include: [],
        exclude: [],
      },
    ]);
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(testDir);
  });

  async function setupDocument(input: {
    collection?: "notes" | "docs";
    relPath: string;
    title?: string;
    markdown: string;
    chunks: ChunkInput[];
  }) {
    const collection = input.collection ?? "notes";
    const key = `${collection}_${input.relPath}`.replace(/\W/g, "");
    const sourceHash = `hash_${key}`;
    const mirrorHash = `mirror_${key}`;

    await adapter.upsertDocument({
      collection,
      relPath: input.relPath,
      sourceHash,
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: input.markdown.length,
      sourceMtime: "2025-01-01T00:00:00Z",
      mirrorHash,
      title: input.title ?? input.relPath,
    });

    await adapter.upsertContent(mirrorHash, input.markdown);
    await adapter.upsertChunks(mirrorHash, input.chunks);
    await adapter.rebuildFtsForHash(mirrorHash);
  }

  test("finds hyphenated compounds as written", async () => {
    await setupDocument({
      relPath: "roadmap.md",
      markdown: "A real-time dashboard reduces feedback lag.",
      chunks: [
        {
          seq: 0,
          pos: 0,
          text: "A real-time dashboard reduces feedback lag.",
          startLine: 1,
          endLine: 1,
        },
      ],
    });

    const result = await adapter.searchFts("real-time");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.relPath).toBe("roadmap.md");
  });

  test("finds digit-hyphen identifiers as written", async () => {
    await setupDocument({
      relPath: "decisions.md",
      markdown: "See DEC-0054 for the final auth-flow choice.",
      chunks: [
        {
          seq: 0,
          pos: 0,
          text: "See DEC-0054 for the final auth-flow choice.",
          startLine: 1,
          endLine: 1,
        },
      ],
    });

    const result = await adapter.searchFts("DEC-0054");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.relPath).toBe("decisions.md");
  });

  test("preserves underscore-heavy identifiers", async () => {
    await setupDocument({
      relPath: "python-style.md",
      markdown: "Use snake_case for local variables in examples.",
      chunks: [
        {
          seq: 0,
          pos: 0,
          text: "Use snake_case for local variables in examples.",
          startLine: 1,
          endLine: 1,
        },
      ],
    });

    const result = await adapter.searchFts("snake_case");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.relPath).toBe("python-style.md");
  });

  test("ranks title hits above incidental body hits", async () => {
    await setupDocument({
      relPath: "title-hit.md",
      title: "JWT token rotation",
      markdown: "Short summary.",
      chunks: [
        { seq: 0, pos: 0, text: "Short summary.", startLine: 1, endLine: 1 },
      ],
    });

    await setupDocument({
      relPath: "body-hit.md",
      title: "General auth notes",
      markdown:
        "This longer note mentions jwt token rotation once near the end.",
      chunks: [
        {
          seq: 0,
          pos: 0,
          text: "This longer note mentions jwt token rotation once near the end.",
          startLine: 1,
          endLine: 1,
        },
      ],
    });

    const result = await adapter.searchFts("jwt token rotation");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value).toHaveLength(2);
    expect(result.value[0]?.relPath).toBe("title-hit.md");
    expect(result.value[1]?.relPath).toBe("body-hit.md");
  });

  test("ranks filepath hits above weak body-only matches for path-oriented lookups", async () => {
    await setupDocument({
      relPath: "auth-flow.md",
      markdown: "Reference doc.",
      chunks: [
        { seq: 0, pos: 0, text: "Reference doc.", startLine: 1, endLine: 1 },
      ],
    });

    await setupDocument({
      relPath: "notes.md",
      markdown:
        "This note mentions auth flow once, but it is not the primary subject.",
      chunks: [
        {
          seq: 0,
          pos: 0,
          text: "This note mentions auth flow once, but it is not the primary subject.",
          startLine: 1,
          endLine: 1,
        },
      ],
    });

    const result = await adapter.searchFts("auth flow");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value).toHaveLength(2);
    expect(result.value[0]?.relPath).toBe("auth-flow.md");
    expect(result.value[1]?.relPath).toBe("notes.md");
  });

  test("preserves intended hit set when collection filter is applied", async () => {
    await setupDocument({
      collection: "notes",
      relPath: "notes-hit.md",
      markdown: "real-time dashboard note",
      chunks: [
        {
          seq: 0,
          pos: 0,
          text: "real-time dashboard note",
          startLine: 1,
          endLine: 1,
        },
      ],
    });
    await setupDocument({
      collection: "docs",
      relPath: "docs-hit.md",
      markdown: "real-time dashboard doc",
      chunks: [
        {
          seq: 0,
          pos: 0,
          text: "real-time dashboard doc",
          startLine: 1,
          endLine: 1,
        },
      ],
    });

    const unfiltered = await adapter.searchFts("real-time");
    expect(unfiltered.ok).toBe(true);
    if (!unfiltered.ok) {
      return;
    }
    expect(unfiltered.value).toHaveLength(2);

    const filtered = await adapter.searchFts("real-time", {
      collection: "notes",
    });
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) {
      return;
    }

    expect(filtered.value).toHaveLength(1);
    expect(filtered.value[0]?.collection).toBe("notes");
    expect(filtered.value[0]?.relPath).toBe("notes-hit.md");
  });

  test("does not leak raw FTS syntax failures for unmatched quotes", async () => {
    await setupDocument({
      relPath: "quotes.md",
      markdown: 'One note about "quoted phrases" in search.',
      chunks: [
        {
          seq: 0,
          pos: 0,
          text: 'One note about "quoted phrases" in search.',
          startLine: 1,
          endLine: 1,
        },
      ],
    });

    const result = await adapter.searchFts('"unterminated');
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error.code).toBe("INVALID_INPUT");
    expect(result.error.message).toContain("unmatched double quote");
  });

  test("supports quoted phrases intentionally", async () => {
    await setupDocument({
      relPath: "phrase.md",
      markdown: "The exact phrase zero downtime deploy appears here.",
      chunks: [
        {
          seq: 0,
          pos: 0,
          text: "The exact phrase zero downtime deploy appears here.",
          startLine: 1,
          endLine: 1,
        },
      ],
    });

    const result = await adapter.searchFts('"zero downtime deploy"');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.relPath).toBe("phrase.md");
  });

  test("supports negation with a positive term", async () => {
    await setupDocument({
      relPath: "include.md",
      markdown: "dashboard metrics",
      chunks: [
        {
          seq: 0,
          pos: 0,
          text: "dashboard metrics",
          startLine: 1,
          endLine: 1,
        },
      ],
    });
    await setupDocument({
      relPath: "exclude.md",
      markdown: "dashboard lag",
      chunks: [
        {
          seq: 0,
          pos: 0,
          text: "dashboard lag",
          startLine: 1,
          endLine: 1,
        },
      ],
    });

    const result = await adapter.searchFts("dashboard -lag");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.relPath).toBe("include.md");
  });
});
