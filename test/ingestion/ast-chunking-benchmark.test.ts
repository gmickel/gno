/**
 * Tests for the experimental AST chunking benchmark harness.
 */

import { describe, expect, test } from "bun:test";

import { chunkWithTreeSitterFallback } from "../../scripts/ast-chunking/chunker";

describe("AST chunking benchmark harness", () => {
  test("falls back for unsupported extensions", async () => {
    const result = await chunkWithTreeSitterFallback(
      "# Title\n\nSome prose content.",
      "note.md"
    );

    expect(result.stats.usedAst).toBe(false);
    expect(result.stats.unsupported).toBe(true);
    expect(result.chunks.length).toBe(1);
  });

  test("falls back for parse errors", async () => {
    const result = await chunkWithTreeSitterFallback(
      "export function broken( {",
      "broken.ts"
    );

    expect(result.stats.usedAst).toBe(false);
    expect(result.stats.parseError).toBe(true);
    expect(result.chunks.length).toBeGreaterThan(0);
  });

  test("preserves stable positions and line metadata", async () => {
    const result = await chunkWithTreeSitterFallback(
      "export function one() {\n  return 1;\n}\n\nexport function two() {\n  return 2;\n}\n",
      "sample.ts",
      { maxTokens: 12, overlapPercent: 0 }
    );

    expect(result.stats.usedAst).toBe(true);
    expect(result.chunks.length).toBeGreaterThanOrEqual(2);
    expect(result.chunks[0]?.pos).toBe(0);
    expect(result.chunks[0]?.startLine).toBe(1);
    expect(result.chunks.at(-1)?.endLine).toBe(7);
  });

  test("splits oversized functions with heuristic fallback", async () => {
    const body = Array.from(
      { length: 80 },
      (_, index) => `  value += ${index};`
    ).join("\n");
    const result = await chunkWithTreeSitterFallback(
      `export function large() {\n  let value = 0;\n${body}\n  return value;\n}\n`,
      "large.ts",
      { maxTokens: 30, overlapPercent: 0 }
    );

    expect(result.stats.usedAst).toBe(true);
    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.chunks.every((chunk) => chunk.text.trim().length > 0)).toBe(
      true
    );
  });
});
