/**
 * Regression: the detach paths must re-exec the argv passed into runCli(),
 * not `process.argv.slice(2)`. Previously `runServeDetach` /
 * `runDaemonDetach` pulled from `process.argv` directly, so programmatic
 * callers (`runCli(["node", "gno", "daemon", "--detach", ...])`) would
 * spawn a child with the host process's argv (e.g. `bun test ...`)
 * instead of the requested invocation.
 *
 * Flagged in the fn-72.4 impl-review (Major). Fix: `runCli` now captures
 * the user-facing argv slice via `setCliArgv` before `parseAsync`, and
 * the detach helpers read from `getCliArgv()`.
 *
 * End-to-end argv plumbing through `spawnDetached` (real subprocess) is
 * exercised by fn-72.5's integration tests.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { getCliArgv, resetGlobals, setCliArgv } from "../../src/cli/program";

describe("CLI argv capture for detach paths", () => {
  afterEach(() => {
    resetGlobals();
  });

  test("getCliArgv returns process.argv.slice(2) before any setCliArgv call", () => {
    resetGlobals();
    expect(getCliArgv()).toEqual(process.argv.slice(2));
  });

  test("getCliArgv returns the captured slice after setCliArgv", () => {
    resetGlobals();
    const argv = [
      "daemon",
      "--detach",
      "--no-sync-on-start",
      "--pid-file",
      "/tmp/test.pid",
    ];
    setCliArgv(argv);
    expect(getCliArgv()).toEqual(argv);
  });

  test("setCliArgv defensively copies its input", () => {
    resetGlobals();
    const original = ["daemon", "--detach"];
    setCliArgv(original);
    // Mutate the source after capture; the captured slice must not see it.
    original.push("--injected");
    expect(getCliArgv()).toEqual(["daemon", "--detach"]);
    expect(getCliArgv()).not.toContain("--injected");
  });

  test("resetGlobals clears the captured argv back to fallback", () => {
    setCliArgv(["serve", "--detach"]);
    expect(getCliArgv()).toEqual(["serve", "--detach"]);
    resetGlobals();
    expect(getCliArgv()).toEqual(process.argv.slice(2));
  });

  test("runCli captures argv before parseAsync (smoke)", async () => {
    // Drive runCli with synthetic argv that is NOT process.argv. The
    // detach branch can't be exercised end-to-end (would actually spawn
    // a subprocess), but we can verify that the capture happened by
    // reading getCliArgv() right after a runCli invocation that errors
    // out fast on a known-bad subcommand.
    const { runCli } = await import("../../src/cli/run");
    const synthArgv = ["node", "gno", "completion-noop-doesnotexist"];
    // runCli will error on the unknown subcommand and return a non-zero
    // code, but the `setCliArgv(argv.slice(2))` happens before parseAsync.
    await runCli(synthArgv);
    expect(getCliArgv()).toEqual(["completion-noop-doesnotexist"]);
  });
});
