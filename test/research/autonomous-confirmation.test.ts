import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("autonomous incumbent confirmation", () => {
  test("repeat benchmark artifact exists for lr95 vs default", async () => {
    const repoRoot = join(import.meta.dir, "../..");
    const file = Bun.file(
      join(
        repoRoot,
        "research/finetune/outputs/auto-entity-lock-default-mix-lr95/repeat-benchmark-vs-auto-entity-lock-default-mix-x3.json"
      )
    );
    expect(await file.exists()).toBe(true);
  });
});
