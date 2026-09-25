import { expect, test } from "bun:test";

import {
  RESIDENT_BUSY_TIMEOUT_MS,
  RESIDENT_STOP_GRACE_MS,
  SHUTDOWN_ABORT_MS,
  SHUTDOWN_DRAIN_MS,
  SHUTDOWN_EXIT_MS,
} from "../../src/core/shutdown-budget";

test("a signal delayed by one resident busy wait still finishes inside the stop grace", () => {
  expect(
    RESIDENT_BUSY_TIMEOUT_MS +
      SHUTDOWN_DRAIN_MS +
      SHUTDOWN_ABORT_MS +
      SHUTDOWN_EXIT_MS
  ).toBeLessThan(RESIDENT_STOP_GRACE_MS);
});
