import { describe, expect, test } from "bun:test";

import run1 from "../../research/finetune/outputs/mlx-run1/benchmark-summary.json";
import run2 from "../../research/finetune/outputs/mlx-run2/benchmark-summary.json";

describe("run comparison intuition", () => {
  test("run2 benchmark is worse than run1 despite lower validation loss", () => {
    const left = run1.candidates[0];
    const right = run2.candidates[0];
    expect(left).toBeDefined();
    expect(right).toBeDefined();
    if (!(left && right)) {
      throw new Error("Missing benchmark candidate");
    }

    expect(right.retrieval.metrics.ndcgAt10).toBeLessThan(
      left.retrieval.metrics.ndcgAt10
    );
    expect(right.expansion.schemaSuccessRate).toBeLessThan(
      left.expansion.schemaSuccessRate
    );
  });
});
