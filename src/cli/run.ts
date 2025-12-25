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

// Known commands for detecting "no subcommand" vs "unknown command"
const KNOWN_COMMANDS = new Set([
  'search',
  'vsearch',
  'query',
  'ask',
  'init',
  'index',
  'status',
  'doctor',
  'collection',
  'context',
  'models',
  'update',
  'embed',
  'cleanup',
  'reset',
  'get',
  'multi-get',
  'ls',
  'mcp',
  'help',
]);

// Known global flags (without values) that can appear before subcommand
const KNOWN_GLOBAL_FLAGS = new Set([
  '--color',
  '--no-color',
  '-v',
  '--verbose',
  '-y',
  '--yes',
  '-q',
  '--quiet',
  '--json',
]);

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
 * Check if argv should trigger concise help.
 * True when: no subcommand AND only KNOWN global flags (or nothing).
 * This allows `gno --json` to show JSON help, not trigger unknown option.
 * Unknown flags like `--badoption` go to Commander to error.
 */
function shouldShowConciseHelp(argv: string[]): boolean {
  const args = argv.slice(2); // Skip node and script

  // No args at all -> concise help
  if (args.length === 0) {
    return true;
  }

  // Check each arg
  for (const arg of args) {
    // Found a subcommand -> let Commander handle it
    if (KNOWN_COMMANDS.has(arg)) {
      return false;
    }
    // Help or version flag -> let Commander handle it
    if (
      arg === '-h' ||
      arg === '--help' ||
      arg === '-V' ||
      arg === '--version'
    ) {
      return false;
    }
    // Known global flag -> continue checking
    if (KNOWN_GLOBAL_FLAGS.has(arg)) {
      continue;
    }
    // Skip flag values (e.g., --index default)
    if (arg.startsWith('-i') || arg.startsWith('--index')) {
      continue;
    }
    if (arg.startsWith('-c') || arg.startsWith('--config')) {
      continue;
    }
    // Unknown flag or non-flag argument -> let Commander handle/error
    return false;
  }

  // Only known global flags, no subcommand -> show concise help
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

  // Show concise help when run with no subcommand (per clig.dev guidelines)
  if (shouldShowConciseHelp(argv)) {
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
