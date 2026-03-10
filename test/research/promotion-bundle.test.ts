import { describe, expect, test } from "bun:test";

import summary from "../../research/finetune/outputs/mlx-run1/promotion/promotion-summary.json";

describe("promotion bundle", () => {
  test("summary records benchmark delta vs baseline", () => {
    expect(summary.benchmark.ndcgAt10).toBeGreaterThan(
      summary.baseline.ndcgAt10
    );
    expect(summary.benchmark.schemaSuccessRate).toBeGreaterThan(
      summary.baseline.schemaSuccessRate
    );
  });

  test("summary includes installable file uri", () => {
    expect(summary.artifact.fileUri.startsWith("file:")).toBe(true);
    expect(summary.artifact.ggufPath.endsWith(".gguf")).toBe(true);
  });
});
