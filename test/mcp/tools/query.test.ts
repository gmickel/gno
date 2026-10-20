/**
 * MCP gno_query tool schema tests.
 */

import { describe, expect, test } from "bun:test";

import { MAX_REQUEST_COLLECTIONS } from "../../../src/core/collection-limits";
import {
  graphQueryInputSchema,
  MCP_TOOL_DESCRIPTIONS,
  queryDiagnoseInputSchema,
  queryInputSchema,
  searchInputSchema,
  vsearchInputSchema,
} from "../../../src/mcp/tools/index";

describe("gno_query schema", () => {
  test("accepts structured query modes and trims text", () => {
    const result = queryInputSchema.safeParse({
      query: "test",
      queryModes: [
        { mode: "term", text: "  exact phrase  " },
        { mode: "intent", text: "  conceptual intent  " },
        { mode: "hyde", text: "  hypothetical answer  " },
      ],
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.queryModes).toEqual([
      { mode: "term", text: "exact phrase" },
      { mode: "intent", text: "conceptual intent" },
      { mode: "hyde", text: "hypothetical answer" },
    ]);
  });

  test("rejects whitespace-only query mode text", () => {
    const result = queryInputSchema.safeParse({
      query: "test",
      queryModes: [{ mode: "term", text: "   " }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects multiple hyde entries", () => {
    const result = queryInputSchema.safeParse({
      query: "test",
      queryModes: [
        { mode: "hyde", text: "first" },
        { mode: "hyde", text: "second" },
      ],
    });
    expect(result.success).toBe(false);
  });

  test("accepts temporal/category/author filters", () => {
    const result = queryInputSchema.safeParse({
      query: "recent meeting notes",
      since: "last month",
      until: "today",
      categories: ["meeting", "notes"],
      author: "gordon",
    });

    expect(result.success).toBe(true);
  });

  test("accepts intent and candidateLimit", () => {
    const result = queryInputSchema.safeParse({
      query: "performance",
      intent: "web performance and latency",
      candidateLimit: 12,
      exclude: ["reviews", "hiring"],
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.intent).toBe("web performance and latency");
    expect(result.data.candidateLimit).toBe(12);
    expect(result.data.exclude).toEqual(["reviews", "hiring"]);
  });

  test("accepts optional explain output", () => {
    const result = queryInputSchema.safeParse({ query: "test", explain: true });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.explain).toBe(true);
  });

  test("tool description nudges agent retrieval controls", () => {
    expect(MCP_TOOL_DESCRIPTIONS.query).toContain("intent");
    expect(MCP_TOOL_DESCRIPTIONS.query).toContain("queryModes");
    expect(MCP_TOOL_DESCRIPTIONS.query).toContain("candidateLimit");
    expect(MCP_TOOL_DESCRIPTIONS.get).toContain("fromLine");
    expect(MCP_TOOL_DESCRIPTIONS.multiGet).toContain("batch top result");
  });

  test("diagnose schema requires a target ref", () => {
    const result = queryDiagnoseInputSchema.safeParse({
      query: "Alice Acme",
      target: "gno://notes/people/alice.md",
      fast: true,
    });

    expect(result.success).toBe(true);
  });

  test("typed graph query schema accepts bounded traversal controls", () => {
    const result = graphQueryInputSchema.safeParse({
      ref: "gno://notes/people/alice.md",
      direction: "both",
      relation: "mentions",
      maxDepth: 2,
      maxNodes: 100,
      frontierLimit: 50,
      visitedLimit: 250,
    });

    expect(result.success).toBe(true);
  });

  test("new tool descriptions explain when to diagnose/query graph", () => {
    expect(MCP_TOOL_DESCRIPTIONS.queryDiagnose).toContain("missing");
    expect(MCP_TOOL_DESCRIPTIONS.queryDiagnose).toContain("stage-by-stage");
  });
});

describe("collections allowlist schema", () => {
  test.each([
    ["gno_query", queryInputSchema],
    ["gno_search", searchInputSchema],
    ["gno_vsearch", vsearchInputSchema],
  ] as const)(
    "%s accepts collections and rejects an empty list",
    (_, schema) => {
      const parsed = schema.safeParse({ query: "x", collections: ["a", "b"] });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.collections).toEqual(["a", "b"]);
      expect(schema.safeParse({ query: "x", collections: [] }).success).toBe(
        false
      );
    }
  );

  test.each([
    ["gno_query", queryInputSchema],
    ["gno_search", searchInputSchema],
    ["gno_vsearch", vsearchInputSchema],
  ] as const)(
    "%s accepts several hundred collections up to the shared bound",
    (_, schema) => {
      const names = (count: number): string[] =>
        Array.from({ length: count }, (_, i) => `c${i}`);
      expect(MAX_REQUEST_COLLECTIONS).toBe(1024);
      for (const count of [180, 500, MAX_REQUEST_COLLECTIONS]) {
        expect(
          schema.safeParse({ query: "x", collections: names(count) }).success
        ).toBe(true);
      }
      expect(
        schema.safeParse({
          query: "x",
          collections: names(MAX_REQUEST_COLLECTIONS + 1),
        }).success
      ).toBe(false);
    }
  );

  test("gno_query_diagnose keeps a single collection", () => {
    expect("collections" in queryDiagnoseInputSchema.shape).toBe(false);
  });
});
