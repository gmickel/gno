import { describe, expect, test } from "bun:test";

describe("autonomous leaderboard", () => {
  test("policy result artifact exists for the baseline keep/discard cycle", async () => {
    const file = Bun.file(
      "/Users/gordon/work/gno/research/finetune/autonomous/runs/policy-mlx-run1.json"
    );
    expect(await file.exists()).toBe(true);
  });
});
