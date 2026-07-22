import { describe, expect, test } from "bun:test";

import {
  diagnosticSearch,
  runCjkLexicalBenchmark,
} from "../../evals/helpers/cjk-lexical-benchmark";
import { renderCjkBenchmarkMarkdown } from "../../evals/helpers/cjk-lexical-report";
import { fingerprintStableResult } from "../../src/bench/cjk-fingerprint";
import {
  buildCjkCaseResult,
  summarizeCjkLanguage,
} from "../../src/bench/cjk-metrics";

describe("CJK benchmark contracts", () => {
  test("reports language metrics and concrete failure categories independently", () => {
    const passing = buildCjkCaseResult({
      queryId: "zh-pass",
      language: "zh",
      category: "identifier",
      query: "编号",
      expected: ["zh/d001.md"],
      judgments: [{ docid: "zh/d001.md", relevance: 3 }],
      topDocs: ["zh/d001.md"],
      warmLatencyMs: 2,
    });
    const failing = buildCjkCaseResult({
      queryId: "zh-fail",
      language: "zh",
      category: "normalization",
      query: "ＡＣＣＴ－９９",
      expected: ["zh/d005.md"],
      judgments: [{ docid: "zh/d005.md", relevance: 3 }],
      topDocs: [],
      warmLatencyMs: 3,
    });

    const result = summarizeCjkLanguage("zh", [passing, failing]);
    expect(result.metrics).toEqual({
      recallAt5: 0.5,
      recallAt10: 0.5,
      mrr: 0.5,
      ndcgAt10: 0.5,
      zeroResultRate: 0.5,
    });
    expect(result.failures).toEqual([
      expect.objectContaining({
        queryId: "zh-fail",
        category: "normalization",
        reason: "zero-result",
        expected: ["zh/d005.md"],
      }),
    ]);
  });

  test("reports ranking only for a genuine retrieved-document misordering", () => {
    const failing = buildCjkCaseResult({
      queryId: "zh-ranking",
      language: "zh",
      category: "ranking",
      query: "排序审计标记 ZHRANK",
      expected: ["zh/d001.md"],
      judgments: [{ docid: "zh/d001.md", relevance: 3 }],
      topDocs: [
        "zh/d002.md",
        "zh/d003.md",
        "zh/d004.md",
        "zh/d005.md",
        "zh/d006.md",
        "zh/d007.md",
        "zh/d001.md",
      ],
      warmLatencyMs: 1,
    });

    expect(summarizeCjkLanguage("zh", [failing]).failures).toEqual([
      expect.objectContaining({
        queryId: "zh-ranking",
        category: "ranking",
        reason: "below-rank-5",
        topDocs: [
          "zh/d002.md",
          "zh/d003.md",
          "zh/d004.md",
          "zh/d005.md",
          "zh/d006.md",
        ],
      }),
    ]);
  });

  test("stable fingerprints exclude timestamps and all millisecond timings", () => {
    const first = {
      generatedAt: "2026-07-22T10:00:00Z",
      buildMs: 1,
      nested: { p95Ms: 2, ranking: ["a", "b"] },
    };
    const second = {
      generatedAt: "2027-01-01T00:00:00Z",
      buildMs: 900,
      nested: { p95Ms: 800, ranking: ["a", "b"] },
    };
    expect(fingerprintStableResult(first)).toBe(
      fingerprintStableResult(second)
    );
    expect(
      fingerprintStableResult({
        ...second,
        nested: { p95Ms: 800, ranking: ["b", "a"] },
      })
    ).not.toBe(fingerprintStableResult(first));
    const artifact = {
      payload: "stable",
      fingerprints: { config: "config", result: "self-reference" },
    };
    expect(fingerprintStableResult(artifact)).toBe(
      fingerprintStableResult({
        ...artifact,
        fingerprints: { ...artifact.fingerprints, result: "changed" },
      })
    );
  });

  test("diagnostic substring lanes never match opaque source paths", () => {
    const documents = [
      {
        id: "zh/leaked-secret.md",
        language: "zh" as const,
        contentSha256: "x",
        title: "普通标题",
        content: "正文没有检索词。",
      },
    ];
    expect(diagnosticSearch(documents, "leaked-secret", "raw")).toEqual([]);
  });

  test("runs production ingestion, BM25, model-free hybrid, and diagnostics", async () => {
    const result = await runCjkLexicalBenchmark({
      queryIds: ["zh-q001"],
      languages: ["zh"],
      generatedAt: "2026-07-22T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      schemaVersion: 1,
      benchmark: "gno-cjk-lexical-degradation",
      corpus: { documentCount: 21, queryCount: 1, languages: ["zh"] },
      index: {
        tokenizer: "snowball english",
      },
    });
    expect(typeof result.index.vocabularyTerms).toBe("number");
    expect(typeof result.index.tokenOccurrences).toBe("number");
    expect(result.index.bytes).toBeGreaterThan(0);
    expect(result.index.vocabularyTerms).toBeGreaterThan(0);
    expect(result.lanes.map((lane) => lane.id)).toEqual([
      "bm25",
      "hybrid-no-models",
      "substring-raw",
      "substring-nfc",
    ]);
    for (const lane of result.lanes) {
      expect(lane.languages).toHaveLength(1);
      expect(lane.cases).toHaveLength(1);
      expect(lane.latency.warmQuery.p50Ms).toBeGreaterThanOrEqual(0);
    }
    expect(result.corpus.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.fingerprints.config).toMatch(/^[a-f0-9]{64}$/);
    expect(result.fingerprints.runtime).toMatch(/^[a-f0-9]{64}$/);
    expect(result.fingerprints.tokenizer).toMatch(/^[a-f0-9]{64}$/);
    expect(result.fingerprints.result).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprintStableResult(result)).toBe(result.fingerprints.result);

    const markdown = renderCjkBenchmarkMarkdown(result);
    expect(markdown).toContain("All positive qrels currently use relevance 3");
    expect(markdown).toContain("title and document content only");
  }, 30_000);
});
