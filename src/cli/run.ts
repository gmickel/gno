/**
 * CLI runner - main entry point.
 * Parses argv, handles errors, returns exit code.
 *
 * @module src/cli/run
 */

import { CommanderError } from 'commander';
import { CliError, exitCodeFor, formatErrorForOutput } from './errors';
import { createProgram } from './program';

/**
 * Check if argv contains --json flag (before end-of-options marker).
 * Used for error formatting before command parsing completes.
 */
function argvWantsJson(argv: string[]): boolean {
  for (const arg of argv) {
    if (arg === '--') {
      break; // Stop at end-of-options marker
    }
    if (arg === '--json') {
      return true;
    }
  }
  return false;
}

/**
 * Run CLI and return exit code.
 * No process.exit() - caller sets process.exitCode.
 */
export async function runCli(argv: string[]): Promise<number> {
  const program = createProgram();
  const isJson = argvWantsJson(argv);

  // Suppress Commander's stderr output in JSON mode
  // so agents get only our structured JSON envelope
  if (isJson) {
    program.configureOutput({
      writeErr: () => {}, // Suppress Commander's error text
    });
  }

  try {
    await program.parseAsync(argv);
    return 0;
  } catch (err) {
    // Handle CliError with proper JSON formatting
    if (err instanceof CliError) {
      const output = formatErrorForOutput(err, { json: isJson });
      process.stderr.write(`${output}\n`);
      return exitCodeFor(err);
    }

    // Handle Commander errors (exitOverride throws these)
    if (err instanceof CommanderError) {
      // Help/version are "successful" exits
      if (
        err.code === 'commander.helpDisplayed' ||
        err.code === 'commander.version'
      ) {
        return 0;
      }

      // Validation errors (missing args, unknown options)
      // Always emit JSON envelope in JSON mode (Commander stderr suppressed above)
      if (isJson) {
        const cliErr = new CliError('VALIDATION', err.message, {
          commanderCode: err.code,
        });
        const output = formatErrorForOutput(cliErr, { json: true });
        process.stderr.write(`${output}\n`);
      }
      return 1;
    }

    // Unexpected errors
    const message = err instanceof Error ? err.message : String(err);
    if (isJson) {
      const cliErr = new CliError('RUNTIME', message);
      const output = formatErrorForOutput(cliErr, { json: true });
      process.stderr.write(`${output}\n`);
    } else {
      process.stderr.write(`Error: ${message}\n`);
    }
    return 2;
  }
}
