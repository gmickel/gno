import { describe, expect, test } from "bun:test";

describe("autonomous incumbent confirmation", () => {
  test("repeat benchmark artifact exists for lr95 vs default", async () => {
    const file = Bun.file(
      "/Users/gordon/work/gno/research/finetune/outputs/auto-entity-lock-default-mix-lr95/repeat-benchmark-vs-auto-entity-lock-default-mix-x3.json"
    );
    expect(await file.exists()).toBe(true);
  });
});
