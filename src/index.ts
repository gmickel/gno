#!/usr/bin/env bun
/**
 * GNO CLI entry point.
 * Thin bootstrap that delegates to CLI runner.
 *
 * @module src/index
 */

import { runCli } from "./cli/run";
import { resetModelManager } from "./llm/nodeLlamaCpp/lifecycle";
import { IMPORT_CHILD_ENV } from "./sessions/import-child-env";

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

// A compiled executable re-run as the session import child (see
// src/sessions/import-child.ts) serves that one request instead of the CLI.
if (process.env[IMPORT_CHILD_ENV] === "1") {
  const { runImportChild } = await import("./sessions/import-child");
  await runImportChild();
  await cleanupAndExit(0);
}

// Await module completion so pending piped stdin keeps Windows Bun alive.
await runCli(process.argv)
  .then((code) => cleanupAndExit(interruptExitCode || code))
  .catch((err) => {
    process.stderr.write(
      `Fatal error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    cleanupAndExit(1).catch(() => {
      // Ignore cleanup errors on exit
    });
  });
