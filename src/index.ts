#!/usr/bin/env bun
/**
 * GNO CLI entry point.
 * Thin bootstrap that delegates to CLI runner.
 *
 * @module src/index
 */

import { runCli } from "./cli/run";
import { resetModelManager } from "./llm/nodeLlamaCpp/lifecycle";

/**
 * Cleanup models and exit.
 * Without this, llama.cpp native threads can keep the process alive.
 */
async function cleanupAndExit(code: number): Promise<never> {
  await resetModelManager().catch(() => {
    // Ignore cleanup errors on exit
  });
  process.exit(code);
}

let interruptExitCode: 0 | 130 = 0;

// Long-running commands install their own SIGINT handler and must finish their
// resource teardown before this bootstrap exits. Short-lived commands have no
// owner, so retain the immediate interrupt behavior for them.
process.on("SIGINT", () => {
  if (process.listenerCount("SIGINT") > 1) {
    return;
  }

  interruptExitCode = 130;
  process.stderr.write("\nInterrupted\n");
  cleanupAndExit(130).catch(() => {
    // Ignore cleanup errors on exit
  });
});

// Run CLI and exit
runCli(process.argv)
  .then((code) => cleanupAndExit(interruptExitCode || code))
  .catch((err) => {
    process.stderr.write(
      `Fatal error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    cleanupAndExit(1).catch(() => {
      // Ignore cleanup errors on exit
    });
  });
