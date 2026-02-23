/**
 * MCP gno_query tool schema tests.
 */

import { describe, expect, test } from "bun:test";

import { queryInputSchema } from "../../../src/mcp/tools/index";

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
});
