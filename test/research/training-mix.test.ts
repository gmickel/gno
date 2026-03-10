import { describe, expect, test } from "bun:test";

import mix from "../../research/finetune/configs/training-mix.json";
import { shouldFilterImportedExample } from "../../research/finetune/lib/mlx-training";

describe("training data improvements", () => {
  test("qmd import filters temporal and release drift examples", () => {
    expect(
      shouldFilterImportedExample("latest qwen 2026 release notes", {
        lexicalQueries: ["latest qwen release notes"],
        vectorQueries: ["recent qwen model release changes"],
      })
    ).toBe(true);

    expect(
      shouldFilterImportedExample("jwt token validation", {
        lexicalQueries: ["jwt token validation"],
        vectorQueries: ["how to validate a jwt token"],
      })
    ).toBe(false);
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
