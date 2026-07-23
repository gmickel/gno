import { describe, expect, test } from "bun:test";

import { askInputSchema } from "../../../src/mcp/tools/ask";
import {
  MCP_TOOL_DESCRIPTIONS,
  MCP_WRITE_TOOL_NAMES,
} from "../../../src/mcp/tools/index";

describe("gno_ask schema", () => {
  test("requires explicit verified synthesis and applies the shared limit", () => {
    const parsed = askInputSchema.safeParse({
      query: "Who owns the launch decision?",
      verify: true,
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.limit).toBe(5);
  });

  test("rejects raw or implicit Ask requests", () => {
    expect(askInputSchema.safeParse({ query: "test" }).success).toBe(false);
    expect(
      askInputSchema.safeParse({ query: "test", verify: false }).success
    ).toBe(false);
  });

  test("preserves normalized retrieval controls and closes the input", () => {
    const valid = askInputSchema.safeParse({
      query: "performance",
      verify: true,
      intent: "web latency",
      exclude: ["hiring"],
      minScore: 0.4,
      graph: true,
      noGraph: true,
      noRerank: true,
      contextBudgetTokens: 8000,
    });
    expect(valid.success).toBe(true);
    if (valid.success) {
      expect(valid.data).toMatchObject({
        limit: 5,
        intent: "web latency",
        exclude: ["hiring"],
        minScore: 0.4,
        graph: true,
        noGraph: true,
        noRerank: true,
        contextBudgetTokens: 8000,
      });
    }

    const parsed = askInputSchema.safeParse({
      query: "performance",
      verify: true,
      intent: "web latency",
      exclude: ["hiring"],
      minScore: 0.4,
      noRerank: true,
      contextBudgetTokens: 8000,
      extra: "rejected",
    });

    expect(parsed.success).toBe(false);
  });

  test("is read-only and describes complete support requirements", () => {
    expect(MCP_WRITE_TOOL_NAMES.has("gno_ask")).toBe(false);
    expect(MCP_TOOL_DESCRIPTIONS.ask).toContain("every substantive claim");
    expect(MCP_TOOL_DESCRIPTIONS.ask).toContain("abstain");
  });
});
