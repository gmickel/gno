import { describe, expect, test } from "bun:test";

import config from "../../research/embeddings/autonomous/config.json";
import searchSpace from "../../research/embeddings/autonomous/search-space.json";

describe("code embedding autonomous harness", () => {
  test("incumbent candidate exists and candidate ids are unique", () => {
    const ids = searchSpace.candidates.map((candidate) => candidate.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(searchSpace.incumbentId);
  });

  test("candidates declare runtime kind and uri", () => {
    for (const candidate of searchSpace.candidates) {
      expect(["native", "http"]).toContain(candidate.runtime.kind);
      expect(candidate.runtime.uri.length).toBeGreaterThan(0);
    }
  });

  test("config declares primary and secondary fixtures", () => {
    expect(config.metric.fixtures.primary.length).toBeGreaterThan(0);
    expect(config.metric.fixtures.secondary?.length ?? 0).toBeGreaterThan(0);
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
