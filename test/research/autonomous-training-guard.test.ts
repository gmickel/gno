import { describe, expect, test } from "bun:test";

import { shouldEarlyStop } from "../../research/finetune/autonomous/lib/training-guard";

describe("autonomous training guard", () => {
  test("waits until min iteration before stopping", () => {
    const decision = shouldEarlyStop(
      [
        { iteration: 100, valLoss: 0.9 },
        { iteration: 200, valLoss: 0.7 },
      ],
      {
        enabled: true,
        minIteration: 500,
        maxBestValLoss: 0.5,
        referenceBestValLoss: 0.312,
        maxValLossDelta: 0.22,
      }
    );

    expect(decision.stop).toBe(false);
    expect(decision.threshold).toBeCloseTo(0.5, 5);
  });

  test("stops when best loss is still above threshold after min iteration", () => {
    const decision = shouldEarlyStop(
      [
        { iteration: 100, valLoss: 0.879 },
        { iteration: 200, valLoss: 0.803 },
        { iteration: 300, valLoss: 0.687 },
        { iteration: 400, valLoss: 0.694 },
        { iteration: 500, valLoss: 0.643 },
      ],
      {
        enabled: true,
        minIteration: 500,
        maxBestValLoss: 0.5,
        referenceBestValLoss: 0.312,
        maxValLossDelta: 0.22,
      }
    );

    expect(decision.stop).toBe(true);
    expect(decision.iteration).toBe(500);
    expect(decision.threshold).toBeCloseTo(0.5, 5);
  });

  test("keeps competitive runs alive", () => {
    const decision = shouldEarlyStop(
      [
        { iteration: 100, valLoss: 0.844 },
        { iteration: 200, valLoss: 0.605 },
        { iteration: 500, valLoss: 0.307 },
      ],
      {
        enabled: true,
        minIteration: 500,
        maxBestValLoss: 0.5,
        referenceBestValLoss: 0.312,
        maxValLossDelta: 0.22,
      }
    );

    expect(decision.stop).toBe(false);
  });
});
