import { describe, expect, test } from "bun:test";

import { isExpectedResidentShutdownExit } from "../../scripts/package-smoke-resident-support";

describe("packed resident shutdown exits", () => {
  test("accepts the platform-specific signal status", () => {
    expect(isExpectedResidentShutdownExit("linux", 143)).toBe(true);
    expect(isExpectedResidentShutdownExit("darwin", 143)).toBe(true);
    expect(isExpectedResidentShutdownExit("win32", 130)).toBe(true);
  });

  test("rejects unrelated nonzero statuses", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      for (const exitCode of [1, 2, 126, 127, 137]) {
        expect(isExpectedResidentShutdownExit(platform, exitCode)).toBe(false);
      }
    }
    expect(isExpectedResidentShutdownExit("linux", 130)).toBe(false);
    expect(isExpectedResidentShutdownExit("win32", 143)).toBe(false);
  });
});
