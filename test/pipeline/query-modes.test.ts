import { describe, expect, test } from "bun:test";

import {
  buildExpansionFromQueryModes,
  parseQueryModeSpec,
  parseQueryModeSpecs,
  summarizeQueryModes,
} from "../../src/pipeline/query-modes";

describe("query-modes", () => {
  test("parses single query mode spec", () => {
    const parsed = parseQueryModeSpec('term:"refresh token" -oauth1');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.value).toEqual({
      mode: "term",
      text: '"refresh token" -oauth1',
    });
  });

  test("rejects invalid query mode prefix", () => {
    const parsed = parseQueryModeSpec("vector:jwt auth");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;

    expect(parsed.error.code).toBe("INVALID_INPUT");
  });

  test("rejects multiple hyde entries", () => {
    const parsed = parseQueryModeSpecs([
      "term:jwt rotation",
      "hyde:first passage",
      "hyde:second passage",
    ]);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;

    expect(parsed.error.message).toContain("Only one hyde mode");
  });

  test("builds expansion result from query modes", () => {
    const parsed = parseQueryModeSpecs([
      "term:jwt refresh token",
      "intent:how refresh token rotation works",
      "hyde:Refresh tokens rotate on each use.",
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const expansion = buildExpansionFromQueryModes(parsed.value);
    expect(expansion).toBeTruthy();
    expect(expansion?.lexicalQueries).toEqual(["jwt refresh token"]);
    expect(expansion?.vectorQueries).toEqual([
      "how refresh token rotation works",
    ]);
    expect(expansion?.hyde).toBe("Refresh tokens rotate on each use.");
  });

  test("summarizes query modes", () => {
    const parsed = parseQueryModeSpecs([
      "term:jwt",
      "term:refresh",
      "intent:auth token lifecycle",
      "hyde:Token rotation invalidates old tokens.",
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(summarizeQueryModes(parsed.value)).toEqual({
      term: 2,
      intent: 1,
      hyde: true,
    });
  });
});
