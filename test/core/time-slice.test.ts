/** fn-208: long main-thread work yields once its slice is over budget. */

import { expect, test } from "bun:test";

import { createTimeSlicer } from "../../src/core/time-slice";

test("yields a macrotask turn only once the slice is over budget", async () => {
  let clock = 0;
  const slicer = createTimeSlicer(20, () => clock);
  let turned = false;
  setImmediate(() => {
    turned = true;
  });

  clock = 10;
  await slicer.maybeYield();
  expect(turned).toBe(false);

  clock = 25;
  await slicer.maybeYield();
  expect(turned).toBe(true);

  // The slice restarts after a yield.
  let again = false;
  setImmediate(() => {
    again = true;
  });
  clock = 30;
  await slicer.maybeYield();
  expect(again).toBe(false);
});
