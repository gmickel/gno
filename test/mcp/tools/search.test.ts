/**
 * MCP gno_search tool tests.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";

// Test the search input/output schemas match spec
describe("gno_search schema", () => {
  const searchInputSchema = z.object({
    query: z.string().min(1, "Query cannot be empty"),
    collection: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(5),
    minScore: z.number().min(0).max(1).optional(),
    lang: z.string().optional(),
    tagsAll: z.array(z.string()).optional(),
    tagsAny: z.array(z.string()).optional(),
  });

  test("search input requires non-empty query", () => {
    const result = searchInputSchema.safeParse({ query: "" });
    expect(result.success).toBe(false);
  });

  test("search input accepts valid query", () => {
    const result = searchInputSchema.safeParse({ query: "test query" });
    expect(result.success).toBe(true);
  });

  test("search input accepts all optional params", () => {
    const result = searchInputSchema.safeParse({
      query: "test",
      collection: "docs",
      limit: 10,
      minScore: 0.5,
      lang: "en",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(10);
    }
  });

  test("search input limit defaults to 5", () => {
    const result = searchInputSchema.safeParse({ query: "test" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(5);
    }
  });

  test("search input rejects limit > 100", () => {
    const result = searchInputSchema.safeParse({ query: "test", limit: 101 });
    expect(result.success).toBe(false);
  });

  test("search input rejects minScore > 1", () => {
    const result = searchInputSchema.safeParse({
      query: "test",
      minScore: 1.5,
    });
    expect(result.success).toBe(false);
  });

  test("search input accepts tagsAll filter", () => {
    const result = searchInputSchema.safeParse({
      query: "test",
      tagsAll: ["work", "urgent"],
    });
    expect(result.success).toBe(true);
  });

  test("search input accepts tagsAny filter", () => {
    const result = searchInputSchema.safeParse({
      query: "test",
      tagsAny: ["work", "personal"],
    });
    expect(result.success).toBe(true);
  });

  test("search input accepts combined tag filters", () => {
    const result = searchInputSchema.safeParse({
      query: "test",
      tagsAll: ["important"],
      tagsAny: ["work", "personal"],
    });
    expect(result.success).toBe(true);
  });
});

describe("gno_search output schema", () => {
  const searchResultSchema = z.object({
    docid: z.string(),
    score: z.number(),
    uri: z.string(),
    title: z.string().optional(),
    snippet: z.string(),
    snippetLanguage: z.string().optional(),
    snippetRange: z
      .object({
        startLine: z.number(),
        endLine: z.number(),
      })
      .optional(),
    source: z.object({
      relPath: z.string(),
      absPath: z.string().optional(),
      mime: z.string(),
      ext: z.string(),
      modifiedAt: z.string().optional(),
      sizeBytes: z.number().optional(),
      sourceHash: z.string().optional(),
    }),
    conversion: z
      .object({
        mirrorHash: z.string(),
      })
      .optional(),
  });

  const searchOutputSchema = z.object({
    results: z.array(searchResultSchema),
    meta: z.object({
      query: z.string(),
      mode: z.enum(["bm25", "vector", "hybrid", "bm25_only"]),
      totalResults: z.number(),
      collection: z.string().optional(),
      lang: z.string().optional(),
      queryLanguage: z.string().optional(),
    }),
  });

  test("search output validates valid result", () => {
    const validOutput = {
      results: [
        {
          docid: "#abc12345",
          score: 0.85,
          uri: "gno://docs/readme.md",
          title: "README",
          snippet: "This is the readme file...",
          source: {
            relPath: "readme.md",
            absPath: "/path/to/docs/readme.md",
            mime: "text/markdown",
            ext: ".md",
          },
        },
      ],
      meta: {
        query: "readme",
        mode: "bm25" as const,
        totalResults: 1,
      },
    };

    const result = searchOutputSchema.safeParse(validOutput);
    expect(result.success).toBe(true);
  });

  test("search output validates empty results", () => {
    const emptyOutput = {
      results: [],
      meta: {
        query: "nonexistent",
        mode: "bm25" as const,
        totalResults: 0,
      },
    };

    const result = searchOutputSchema.safeParse(emptyOutput);
    expect(result.success).toBe(true);
  });
});
