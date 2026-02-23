import { describe, expect, test } from "bun:test";

import { applyExpansionGuardrails } from "../../src/pipeline/expansion";

describe("expansion guardrails", () => {
  test("preserves entities, quoted phrases, and negations in lexical variants", () => {
    const query = 'meeting with Bob about "C++ templates" -redis';
    const guarded = applyExpansionGuardrails(query, {
      lexicalQueries: ["c++ meetings", "programming sync notes"],
      vectorQueries: ["meeting notes about C++"],
    });

    expect(guarded.lexicalQueries[0]).toContain("Bob");
    expect(guarded.lexicalQueries[0]).toContain('"C++ templates"');
    expect(guarded.lexicalQueries[0]).toContain("-redis");
  });

  test("filters drifted lexical and vector variants and falls back to query", () => {
    const query = "kubernetes deployment strategy";
    const guarded = applyExpansionGuardrails(query, {
      lexicalQueries: ["best restaurants in paris"],
      vectorQueries: ["how to bake sourdough"],
    });

    expect(guarded.lexicalQueries).toEqual(["kubernetes deployment strategy"]);
    expect(guarded.vectorQueries).toEqual(["kubernetes deployment strategy"]);
  });

  test("drops hyde content when it has no overlap with query", () => {
    const query = "oauth token rotation";
    const guarded = applyExpansionGuardrails(query, {
      lexicalQueries: ["oauth token rotation"],
      vectorQueries: ["how oauth token rotation works"],
      hyde: "Banana bread recipes with walnuts and cinnamon.",
    });

    expect(guarded.hyde).toBeUndefined();
  });

  test("deduplicates and caps variants", () => {
    const query = "api auth flow";
    const guarded = applyExpansionGuardrails(query, {
      lexicalQueries: [
        "api auth flow",
        "api auth flow",
        "API auth flow",
        "api authentication flow",
        "auth api flow",
        "api flow auth",
        "authentication pipeline",
      ],
      vectorQueries: [
        "how api auth flow works",
        "how api auth flow works",
        "api authentication architecture",
        "api auth lifecycle",
        "api token auth flow",
        "api auth implementation",
        "api auth details",
      ],
    });

    expect(guarded.lexicalQueries.length).toBeLessThanOrEqual(5);
    expect(guarded.vectorQueries.length).toBeLessThanOrEqual(5);
    expect(new Set(guarded.lexicalQueries).size).toBe(
      guarded.lexicalQueries.length
    );
    expect(new Set(guarded.vectorQueries).size).toBe(
      guarded.vectorQueries.length
    );
  });
});
