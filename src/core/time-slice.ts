/**
 * Cooperative time slicing for long synchronous work on a resident's main
 * thread.
 *
 * Bun runs SQLite synchronously, so a loop of store calls never lets the
 * event loop serve a request until it ends, however many `await`s it
 * contains (they resolve as microtasks). Call `maybeYield()` between units of
 * work: once the current slice has run longer than its budget, it yields a
 * macrotask turn so pending requests (status, search) are answered.
 *
 * @module src/core/time-slice
 */

/** Longest a slice runs before yielding; keeps status well under 100 ms. */
export const DEFAULT_TIME_SLICE_MS = 20;

export interface TimeSlicer {
  /** Yield to the event loop if the current slice is over budget. */
  maybeYield(): Promise<void>;
}

export function createTimeSlicer(
  budgetMs = DEFAULT_TIME_SLICE_MS,
  now: () => number = performance.now.bind(performance)
): TimeSlicer {
  let sliceStart = now();
  return {
    async maybeYield() {
      if (now() - sliceStart < budgetMs) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
      sliceStart = now();
    },
  };
}
