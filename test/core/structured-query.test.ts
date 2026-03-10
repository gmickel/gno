import { describe, expect, test } from "bun:test";

import { normalizeStructuredQueryInput } from "../../src/core/structured-query";
import { buildExpansionFromQueryModes } from "../../src/pipeline/query-modes";

describe("structured query documents", () => {
  test("single-line queries remain unchanged", () => {
    const result = normalizeStructuredQueryInput("JWT token");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.usedStructuredQuerySyntax).toBe(false);
    expect(result.value.query).toBe("JWT token");
    expect(result.value.queryModes).toEqual([]);
  });

  test("parses mixed plain and typed lines", () => {
    const result = normalizeStructuredQueryInput(
      "auth flow\nterm: jwt refresh token\nintent: token rotation"
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.usedStructuredQuerySyntax).toBe(true);
    expect(result.value.derivedQuery).toBe(false);
    expect(result.value.query).toBe("auth flow");
    expect(result.value.queryModes).toEqual([
      { mode: "term", text: "jwt refresh token" },
      { mode: "intent", text: "token rotation" },
    ]);
  });

  test("derives query from term lines when no plain query line exists", () => {
    const result = normalizeStructuredQueryInput(
      "term: jwt refresh token\nintent: token rotation"
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.derivedQuery).toBe(true);
    expect(result.value.query).toBe("jwt refresh token");
  });

  test("falls back to intent lines when there are no term lines", () => {
    const result = normalizeStructuredQueryInput(
      "intent: web performance latency\nintent: vitals budgets"
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.derivedQuery).toBe(true);
    expect(result.value.query).toBe("web performance latency vitals budgets");
  });

  test("rejects hyde-only documents", () => {
    const result = normalizeStructuredQueryInput("hyde: imagined answer");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.usedStructuredQuerySyntax).toBe(false);

    const multiline = normalizeStructuredQueryInput("hyde: imagined answer\n");
    expect(multiline.ok).toBe(false);
    if (multiline.ok) return;
    expect(multiline.error.message).toContain("hyde-only");
  });

  test("rejects unknown typed prefixes when structured syntax is active", () => {
    const result = normalizeStructuredQueryInput(
      "term: jwt refresh token\nvector: semantic expansion"
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain(
      "Unknown structured query line prefix"
    );
    expect(result.error.line).toBe(2);
  });

  test("rejects duplicate hyde across document syntax and explicit query modes", () => {
    const result = normalizeStructuredQueryInput("hyde: first\nterm: jwt", [
      { mode: "hyde", text: "second" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Only one hyde entry");
  });

  test("normalizes into the same expansion structure used by query modes", () => {
    const result = normalizeStructuredQueryInput(
      "auth flow\nterm: jwt refresh token\nintent: token rotation\nhyde: refresh tokens rotate on use"
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(buildExpansionFromQueryModes(result.value.queryModes)).toEqual({
      lexicalQueries: ["jwt refresh token"],
      vectorQueries: ["token rotation"],
      hyde: "refresh tokens rotate on use",
    });
  });
});
