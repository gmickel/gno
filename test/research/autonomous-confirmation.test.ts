import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("autonomous incumbent confirmation", () => {
  test("confirmation script exists", async () => {
    const repoRoot = join(import.meta.dir, "../..");
    const file = Bun.file(
      join(repoRoot, "research/finetune/autonomous/scripts/confirm-winner.ts")
    );
    expect(await file.exists()).toBe(true);
  });
});
