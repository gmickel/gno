import { describe, expect, test } from "bun:test";

import config from "../../research/finetune/autonomous/config.json";

describe("autonomous policy cycle", () => {
  test("mutation targets stay inside allowed roots", () => {
    for (const target of config.mutationTargets) {
      expect(config.allowedRoots.some((root) => target.startsWith(root))).toBe(
        true
      );
    }
  });

  test("promotion gate remains human-controlled", () => {
    expect(config.promotion.humanApprovalRequired).toBe(true);
  });
});
