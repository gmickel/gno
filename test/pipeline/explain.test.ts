import { describe, expect, test } from "bun:test";

import {
  buildExplainResults,
  formatResultExplain,
} from "../../src/pipeline/explain";

describe("pipeline explain", () => {
  test("buildExplainResults includes fusion score contribution", () => {
    const results = buildExplainResults(
      [
        {
          mirrorHash: "hash1",
          seq: 0,
          bm25Rank: 1,
          vecRank: 2,
          fusionScore: 0.033,
          sources: ["bm25", "vector"],
          rerankScore: 0.8,
          blendedScore: 0.9,
        },
      ],
      new Map([["hash1:0", "#abc123"]])
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.fusionScore).toBe(0.033);
  });

  test("formatResultExplain prints fusion, bm25, vec, rerank fields", () => {
    const text = formatResultExplain([
      {
        rank: 1,
        docid: "#abc123",
        score: 0.9,
        fusionScore: 0.033,
        bm25Score: 0.5,
        vecScore: 0.2,
        rerankScore: 0.8,
      },
    ]);

    expect(text).toContain("fusion=0.033");
    expect(text).toContain("bm25=0.50");
    expect(text).toContain("vec=0.20");
    expect(text).toContain("rerank=0.80");
  });
});
