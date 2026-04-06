import { describe, expect, test } from "bun:test";

import queries from "../../evals/fixtures/code-embedding-benchmark/queries.json";

interface QueryCase {
  id: string;
  relevantDocs: string[];
}

describe("code embedding benchmark fixtures", () => {
  test("all relevant docs exist in the corpus", async () => {
    const corpusRoot = "evals/fixtures/code-embedding-benchmark/corpus";
    const cases = queries as QueryCase[];
    for (const testCase of cases) {
      expect(testCase.id.length).toBeGreaterThan(0);
      expect(testCase.relevantDocs.length).toBeGreaterThan(0);
      for (const doc of testCase.relevantDocs) {
        const file = Bun.file(`${corpusRoot}/${doc}`);
        expect(await file.exists()).toBe(true);
      }
    }
  });

  test("benchmark script supports dry-run candidate resolution", () => {
    const result = Bun.spawnSync({
      cmd: [
        "bun",
        "scripts/code-embedding-benchmark.ts",
        "--candidate",
        "bge-m3-incumbent",
        "--dry-run",
      ],
      cwd: "/Users/gordon/work/gno",
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(new TextDecoder().decode(result.stdout)) as {
      candidateId: string;
      embedModel: string;
    };
    expect(output.candidateId).toBe("bge-m3-incumbent");
    expect(output.embedModel).toContain("bge-m3");
  });

  test("benchmark script supports fixture selection in dry-run mode", () => {
    const result = Bun.spawnSync({
      cmd: [
        "bun",
        "scripts/code-embedding-benchmark.ts",
        "--candidate",
        "bge-m3-incumbent",
        "--fixture",
        "repo-serve",
        "--dry-run",
      ],
      cwd: "/Users/gordon/work/gno",
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(new TextDecoder().decode(result.stdout)) as {
      fixture: string;
    };
    expect(output.fixture).toBe("repo-serve");
  });
});
