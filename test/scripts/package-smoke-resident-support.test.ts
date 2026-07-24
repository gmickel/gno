import { describe, expect, test } from "bun:test";

import {
  isExpectedResidentShutdownExit,
  waitForStatus,
} from "../../scripts/package-smoke-resident-support";

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

  test("reports process output immediately when startup exits", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        "console.log('resident stdout'); console.error('resident stderr'); process.exit(2)",
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    const startedAt = performance.now();
    const startupError = await waitForStatus("http://127.0.0.1:1", "serve", {
      child,
      stdout: new Response(child.stdout).text(),
      stderr: new Response(child.stderr).text(),
    }).catch((error: unknown) => error);

    expect(startupError).toBeInstanceOf(Error);
    expect((startupError as Error).message).toContain(
      "exited 2 before listener readiness"
    );
    expect((startupError as Error).message).toContain("resident stdout");
    expect((startupError as Error).message).toContain("resident stderr");
    expect(performance.now() - startedAt).toBeLessThan(5000);
  });
});
