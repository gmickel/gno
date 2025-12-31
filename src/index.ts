#!/usr/bin/env bun
/**
 * GNO CLI entry point.
 * Thin bootstrap that delegates to CLI runner.
 *
 * @module src/index
 */

import { runCli } from './cli/run';

// SIGINT handler for graceful shutdown
process.on('SIGINT', () => {
  process.stderr.write('\nInterrupted\n');
  process.exit(130);
});

// Run CLI and exit
runCli(process.argv)
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    process.stderr.write(
      `Fatal error: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  });
