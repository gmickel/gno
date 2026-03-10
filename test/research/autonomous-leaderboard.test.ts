import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("autonomous leaderboard", () => {
  test("policy result artifact exists for the baseline keep/discard cycle", async () => {
    const repoRoot = join(import.meta.dir, "../..");
    const file = Bun.file(
      join(repoRoot, "research/finetune/autonomous/runs/policy-mlx-run1.json")
    );
    expect(await file.exists()).toBe(true);
  });
});
