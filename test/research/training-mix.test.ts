import { describe, expect, test } from "bun:test";

import mix from "../../research/finetune/configs/training-mix.json";

describe("training data improvements", () => {
  test("qmd import filters at least some low-quality imported examples", async () => {
    const report = (await Bun.file(
      new URL(
        "../../research/finetune/data/generated/qmd-import-report.json",
        import.meta.url
      )
    ).json()) as { filtered: number; kept: number };
    expect(report.filtered).toBeGreaterThan(0);
    expect(report.kept).toBeGreaterThan(0);
  });

  test("training mix oversamples gno-specific data", () => {
    const hardcase = mix.entries.find(
      (entry) => entry.name === "gno-hardcases"
    );
    const multilingual = mix.entries.find(
      (entry) => entry.name === "gno-multilingual-hardcases"
    );

    expect(hardcase?.repeat).toBeGreaterThan(1);
    expect(multilingual?.repeat).toBeGreaterThan(1);
  });
});
