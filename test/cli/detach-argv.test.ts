/**
 * Regression: the detach paths must re-exec the argv passed into runCli(),
 * not `process.argv.slice(2)`. Previously `runServeDetach` /
 * `runDaemonDetach` pulled from `process.argv` directly, so programmatic
 * callers (`runCli(["node", "gno", "daemon", "--detach", ...])`) would
 * spawn a child with the host process's argv (e.g. `bun test ...`)
 * instead of the requested invocation.
 *
 * Flagged in the fn-72.4 impl-review (Major). Fix: the detach helpers now
 * receive `argv` from `resolveCliArgv(cmd)`, which walks up to the root
 * Commander Command and reads `rawArgs.slice(2)`. Per-invocation, no
 * process-global state — back-to-back `runCli([...])` calls in the same
 * process can't taint each other's child argv.
 *
 * End-to-end argv plumbing through `spawnDetached` (real subprocess) is
 * exercised by fn-72.5's integration tests.
 */

import { describe, expect, test } from "bun:test";
import { Command } from "commander";

import { resolveCliArgv } from "../../src/cli/program";

function buildProgram(captured: { leaf: Command | null }): Command {
  const program = new Command()
    .name("gno")
    .exitOverride()
    .allowExcessArguments(true)
    .allowUnknownOption(true);
  program
    .command("daemon")
    .allowExcessArguments(true)
    .allowUnknownOption(true)
    .action(function (this: Command) {
      captured.leaf = this;
    });
  program
    .command("search")
    .allowExcessArguments(true)
    .allowUnknownOption(true)
    .action(function (this: Command) {
      captured.leaf = this;
    });
  return program;
}

describe("resolveCliArgv (detach argv source)", () => {
  test("returns rawArgs.slice(2) from a freshly parsed command", async () => {
    const captured: { leaf: Command | null } = { leaf: null };
    const program = buildProgram(captured);
    await program.parseAsync([
      "node",
      "gno",
      "daemon",
      "--detach",
      "--pid-file",
      "/tmp/x.pid",
    ]);
    expect(captured.leaf).not.toBeNull();
    expect(resolveCliArgv(captured.leaf!)).toEqual([
      "daemon",
      "--detach",
      "--pid-file",
      "/tmp/x.pid",
    ]);
  });

  test("walks up to the root from a leaf sub-command", async () => {
    const captured: { leaf: Command | null } = { leaf: null };
    const program = buildProgram(captured);
    await program.parseAsync(["node", "gno", "daemon", "--no-sync-on-start"]);
    // Sanity: the captured Command IS the leaf (daemon), not the root.
    expect(captured.leaf!.name()).toBe("daemon");
    expect(captured.leaf!.parent).not.toBeNull();
    // resolveCliArgv must walk to the root and return rawArgs.slice(2).
    expect(resolveCliArgv(captured.leaf!)).toEqual([
      "daemon",
      "--no-sync-on-start",
    ]);
  });

  test("two back-to-back parses on SEPARATE programs don't taint each other", async () => {
    // The whole point of dropping the process-global capture: if
    // runCli(serve ...) runs, then later runCli(daemon --detach) runs,
    // the second invocation must see its own argv, not the first's.
    const capturedA: { leaf: Command | null } = { leaf: null };
    const programA = buildProgram(capturedA);
    await programA.parseAsync(["node", "gno", "search", "foo"]);
    expect(resolveCliArgv(capturedA.leaf!)).toEqual(["search", "foo"]);

    const capturedB: { leaf: Command | null } = { leaf: null };
    const programB = buildProgram(capturedB);
    await programB.parseAsync(["node", "gno", "daemon", "--detach"]);
    expect(resolveCliArgv(capturedB.leaf!)).toEqual(["daemon", "--detach"]);
    // The first program's leaf must still report ITS argv, not the second's.
    expect(resolveCliArgv(capturedA.leaf!)).toEqual(["search", "foo"]);
  });

  test("re-parse of the same Command instance reflects the new argv", async () => {
    const captured: { leaf: Command | null } = { leaf: null };
    const program = buildProgram(captured);
    await program.parseAsync(["node", "gno", "daemon", "--first"]);
    expect(resolveCliArgv(captured.leaf!)).toEqual(["daemon", "--first"]);
    await program.parseAsync(["node", "gno", "daemon", "--second"]);
    expect(resolveCliArgv(captured.leaf!)).toEqual(["daemon", "--second"]);
  });
});
