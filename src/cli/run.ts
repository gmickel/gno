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
 * Check if argv has no user arguments at all.
 * Only returns true for bare `gno` invocation.
 */
function argvIsEmpty(argv: string[]): boolean {
  // argv[0] = node, argv[1] = gno (or script path)
  return argv.length <= 2;
}

/**
 * Print concise help when gno is run with no args.
 * Per clig.dev: show brief usage, examples, and pointer to --help.
 */
function printConciseHelp(opts: { json: boolean }): void {
  if (opts.json) {
    const help = {
      name: 'gno',
      description: 'GNO - Local Knowledge Index and Retrieval',
      usage: 'gno <command> [options]',
      examples: [
        'gno init ~/docs --name docs',
        'gno index',
        'gno ask "your question"',
      ],
      help: 'Run gno --help for full command list',
    };
    process.stdout.write(`${JSON.stringify(help, null, 2)}\n`);
  } else {
    process.stdout.write(`GNO - Local Knowledge Index and Retrieval

Usage: gno <command> [options]

Quick start:
  gno init ~/docs --name docs    Initialize with a collection
  gno index                      Build the index
  gno ask "your question"        Search your knowledge

Run 'gno --help' for full command list.
`);
  }
}

/**
 * Run CLI and return exit code.
 * No process.exit() - caller sets process.exitCode.
 */
export async function runCli(argv: string[]): Promise<number> {
  const isJson = argvWantsJson(argv);

  // Show concise help when run with no args (per clig.dev guidelines)
  if (argvIsEmpty(argv)) {
    printConciseHelp({ json: isJson });
    return 0;
  }

  const program = createProgram();

  // Suppress Commander's stderr output in JSON mode
  // so agents get only our structured JSON envelope
  if (isJson) {
    program.configureOutput({
      writeErr: () => {
        // Intentionally empty: suppress Commander's stderr
      },
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
      // commander.helpDisplayed: --help or -h flag
      // commander.help: help subcommand (e.g., help collection)
      // commander.version: --version or -V flag
      if (
        err.code === 'commander.helpDisplayed' ||
        err.code === 'commander.help' ||
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
