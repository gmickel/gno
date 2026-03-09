import { describe, expect, test } from "bun:test";

import config from "../../research/finetune/autonomous/config.json";

describe("autonomous harness", () => {
  test("mutation roots stay inside research sandbox", () => {
    for (const root of config.allowedRoots) {
      expect(root.startsWith("research/finetune/")).toBe(true);
    }
  });

  test("disallowed roots protect product code and benchmark fixtures", () => {
    expect(config.disallowedRoots).toContain("src/");
    expect(config.disallowedRoots).toContain("docs/");
    expect(config.disallowedRoots).toContain("evals/fixtures/");
    expect(config.metric.promotionSplit).toBe("heldout");
  });
});
