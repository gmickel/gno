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
 * End `stream` and resolve once its queued writes have reached the OS.
 * process.exit() drops pending asynchronous pipe writes, so a pipe consumer
 * would otherwise see output cut at the pipe buffer size. Bun reports no
 * writableLength and fires an empty write's callback immediately, so end()
 * is the flush that actually waits. A closed consumer (EPIPE) settles
 * through the callback or the 'error' event.
 */
const pendingFlushes = new WeakMap<NodeJS.WriteStream, Promise<void>>();

/**
 * Concurrent exit paths (normal completion racing a SIGINT) share one flush:
 * a second caller must wait for the drain the first end() started, not treat
 * the already-ended stream as flushed and exit mid-write.
 */
function flushStream(stream: NodeJS.WriteStream): Promise<void> {
  const pending = pendingFlushes.get(stream);
  if (pending) {
    return pending;
  }
  if (stream.destroyed || stream.writableEnded) {
    return Promise.resolve();
  }
  const flush = new Promise<void>((resolve) => {
    stream.once("error", () => resolve());
    stream.end(() => resolve());
  });
  pendingFlushes.set(stream, flush);
  return flush;
}

/**
 * Cleanup models, flush output, and exit.
 * Without the explicit exit, llama.cpp native threads can keep the process alive.
 */
async function cleanupAndExit(code: number): Promise<never> {
  await resetModelManager().catch(() => {
    // Ignore cleanup errors on exit
  });
  await Promise.all([flushStream(process.stdout), flushStream(process.stderr)]);
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
