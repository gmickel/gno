#!/usr/bin/env bun
/**
 * GNO CLI entry point.
 * Thin bootstrap that delegates to CLI runner.
 *
 * @module src/index
 */

import { runCli } from './cli/run';
import { resetModelManager } from './llm/nodeLlamaCpp/lifecycle';

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

// SIGINT handler for graceful shutdown
process.on('SIGINT', () => {
  process.stderr.write('\nInterrupted\n');
  cleanupAndExit(130).catch(() => {
    // Ignore cleanup errors on exit
  });
});

// Run CLI and exit
runCli(process.argv)
  .then((code) => cleanupAndExit(code))
  .catch((err) => {
    process.stderr.write(
      `Fatal error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    cleanupAndExit(1).catch(() => {
      // Ignore cleanup errors on exit
    });
  });
