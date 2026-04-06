import { describe, expect, test } from "bun:test";

import config from "../../research/embeddings/autonomous/config.json";
import searchSpace from "../../research/embeddings/autonomous/search-space.json";

describe("code embedding autonomous harness", () => {
  test("incumbent candidate exists and candidate ids are unique", () => {
    const ids = searchSpace.candidates.map((candidate) => candidate.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(searchSpace.incumbentId);
  });

  test("allowed roots stay inside research/embeddings or benchmark harness files", () => {
    for (const root of config.allowedRoots) {
      expect(
        root.startsWith("research/embeddings/") ||
          root === "evals/helpers/code-embedding-benchmark.ts" ||
          root.startsWith("evals/fixtures/code-embedding-benchmark/") ||
          root === "scripts/code-embedding-benchmark.ts"
      ).toBe(true);
    }
  });
});
