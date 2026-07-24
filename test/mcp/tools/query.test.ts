/**
 * MCP gno_query tool schema tests.
 */

import { describe, expect, test } from "bun:test";

import {
  graphQueryInputSchema,
  MCP_TOOL_DESCRIPTIONS,
  queryDiagnoseInputSchema,
  queryInputSchema,
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
