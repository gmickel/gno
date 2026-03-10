import { describe, expect, test } from "bun:test";

import searchSpace from "../../research/finetune/autonomous/search-space.json";

describe("autonomous search space", () => {
  test("candidates are small prompt/mix deltas", () => {
    expect(searchSpace.candidates.length).toBeGreaterThan(0);
    for (const candidate of searchSpace.candidates) {
      expect(candidate.mix.startsWith("research/finetune/configs/")).toBe(true);
      expect(
        candidate.promptProfile.startsWith("research/finetune/configs/")
      ).toBe(true);
    }
  });
});
