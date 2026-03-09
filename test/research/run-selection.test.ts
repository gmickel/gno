import { describe, expect, test } from "bun:test";

import {
  parseValLossRecords,
  selectBestValCheckpoint,
} from "../../research/finetune/lib/run-selection";

describe("run selection", () => {
  const log = `
Iter 100: Val loss 0.865, Val took 0.330s
Iter 200: Val loss 0.696, Val took 0.429s
Iter 900: Val loss 0.312, Val took 0.862s
Iter 1000: Val loss 0.705, Val took 0.960s
`;

  test("parses val checkpoints from log", () => {
    expect(parseValLossRecords(log)).toEqual([
      { iteration: 100, valLoss: 0.865 },
      { iteration: 200, valLoss: 0.696 },
      { iteration: 900, valLoss: 0.312 },
      { iteration: 1000, valLoss: 0.705 },
    ]);
  });

  test("selects best checkpoint by minimum val loss", () => {
    const best = selectBestValCheckpoint(
      log,
      "research/finetune/outputs/mlx-run1"
    );
    expect(best?.iteration).toBe(900);
    expect(best?.adapterFile).toContain("0000900_adapters.safetensors");
  });
});
