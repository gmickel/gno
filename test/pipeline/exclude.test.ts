import { describe, expect, test } from "bun:test";

import {
  matchesExcludedChunks,
  matchesExcludedText,
  normalizeExcludeTerms,
} from "../../src/pipeline/exclude";

describe("exclude helpers", () => {
  test("normalizeExcludeTerms splits, trims, and deduplicates", () => {
    expect(
      normalizeExcludeTerms(["reviews, onboarding", "Reviews", " hiring "])
    ).toEqual(["reviews", "onboarding", "hiring"]);
  });

  test("matchesExcludedText is case-insensitive", () => {
    expect(
      matchesExcludedText(
        ["Web performance and latency notes", "team review process"],
        ["Review"]
      )
    ).toBe(true);
    expect(
      matchesExcludedText(["Web performance and latency notes"], ["hiring"])
    ).toBe(false);
  });

  test("matchesExcludedChunks scans chunk bodies", () => {
    expect(
      matchesExcludedChunks(
        [
          {
            mirrorHash: "hash-1",
            seq: 0,
            pos: 0,
            text: "Quarterly performance review process",
            startLine: 1,
            endLine: 1,
            language: "en",
            tokenCount: null,
            createdAt: "2026-03-08T00:00:00.000Z",
          },
        ],
        ["review"]
      )
    ).toBe(true);
  });
});
