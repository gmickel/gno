import { describe, expect, test } from "bun:test";

import sweep from "../../research/finetune/configs/alternate-base-sweep.json";

describe("alternate base sweep", () => {
  test("contains current winner plus required alternate families", () => {
    const ids = sweep.alternates.map((candidate) => candidate.id);
    expect(sweep.defaultWinner.baseModel).toContain("Qwen3-1.7B");
    expect(ids).toContain("qwen2.5-3b");
    expect(ids).toContain("qwen3.5-0.8b");
  });

  test("documents when to stay on the current winner", () => {
    expect(sweep.decisionRules.stayOnWinnerWhen.length).toBeGreaterThan(0);
    expect(sweep.decisionRules.runAlternateSweepWhen.length).toBeGreaterThan(0);
  });
});
