/**
 * CLI runner - main entry point.
 * Parses argv, handles errors, returns exit code.
 *
 * @module src/cli/run
 */

import { CommanderError } from 'commander';
import { CLI_NAME, PRODUCT_NAME } from '../app/constants';
import { CliError, exitCodeFor, formatErrorForOutput } from './errors';
import { createProgram, resetGlobals } from './program';

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

// Known global flags (boolean) - includes both --no-color and --color (negatable)
const KNOWN_BOOL_FLAGS = new Set([
  '--color',
  '--no-color',
  '--verbose',
  '--yes',
  '-q',
  '--quiet',
  '--json',
  '--offline',
]);

// Known global flags that take values (--flag value or --flag=value)
const KNOWN_VALUE_FLAGS = ['--index', '--config'] as const;

/**
 * Check if arg is a known value flag (--index, --config, or --index=val form).
 */
function isKnownValueFlag(arg: string): boolean {
  for (const flag of KNOWN_VALUE_FLAGS) {
    if (arg === flag || arg.startsWith(`${flag}=`)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if argv has no subcommand (only known global flags).
 * Returns true for: gno, gno --json, gno --quiet --verbose
 * Returns false for: gno search, gno init, gno --help, gno --badoption, etc.
 *
 * Edge cases handled:
 * - `gno -- search` → false (content after --)
 * - `gno --index` → false (missing value, let Commander error)
 * - `gno --index=foo` → true (equals form supported)
 * - `gno --color` → true (negatable flag pair)
 */
function hasNoSubcommand(argv: string[]): boolean {
  // Skip first two (node, script path)
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i] as string; // Guaranteed by loop bounds

    // End of options marker
    if (arg === '--') {
      // Only "no subcommand" if nothing comes after --
      return i === argv.length - 1;
    }

    // Known boolean flag - skip
    if (KNOWN_BOOL_FLAGS.has(arg)) {
      continue;
    }

    // Known value flag with = syntax (--index=foo)
    if (isKnownValueFlag(arg) && arg.includes('=')) {
      continue;
    }

    // Known value flag without = (--index foo)
    if (isKnownValueFlag(arg)) {
      const nextArg = argv[i + 1];
      // Missing value or next is a flag → let Commander handle/error
      if (nextArg === undefined || nextArg.startsWith('-')) {
        return false;
      }
      i += 1; // Skip the value
      continue;
    }

    // Anything else (subcommand, unknown flag, --help, etc.) → not "no subcommand"
    return false;
  }
  return true;
}

/**
 * Print concise help when gno is run with no subcommand.
 * Per clig.dev: show brief usage, examples, and pointer to --help.
 */
function printConciseHelp(opts: { json: boolean }): void {
  if (opts.json) {
    const help = {
      name: CLI_NAME,
      description: `${PRODUCT_NAME} - Local Knowledge Index and Retrieval`,
      usage: `${CLI_NAME} <command> [options]`,
      examples: [
        `${CLI_NAME} init ~/docs --name docs`,
        `${CLI_NAME} index`,
        `${CLI_NAME} ask "your question"`,
      ],
      help: `Run ${CLI_NAME} --help for full command list`,
    };
    process.stdout.write(`${JSON.stringify(help, null, 2)}\n`);
  } else {
    process.stdout.write(`${PRODUCT_NAME} - Local Knowledge Index and Retrieval

Usage: ${CLI_NAME} <command> [options]

Quick start:
  ${CLI_NAME} init ~/docs --name docs    Initialize with a collection
  ${CLI_NAME} index                      Build the index
  ${CLI_NAME} ask "your question"        Search your knowledge

Run '${CLI_NAME} --help' for full command list.
`);
  }
}

/**
 * Run CLI and return exit code.
 * No process.exit() - caller sets process.exitCode.
 */
export async function runCli(argv: string[]): Promise<number> {
  // Reset global state for clean invocation (important for testing)
  resetGlobals();

  const isJson = argvWantsJson(argv);

  // Handle "no subcommand" case before Commander (avoids full help display)
  if (hasNoSubcommand(argv)) {
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
