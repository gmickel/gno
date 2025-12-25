/**
 * Action wrapper for consistent global options resolution.
 * Ensures all commands properly resolve global flags.
 *
 * @module src/cli/action
 */

import type { Command } from 'commander';
import { type GlobalOptions, resolveGlobalOptions } from './context';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ActionContext = {
  globals: GlobalOptions;
};

// ─────────────────────────────────────────────────────────────────────────────
// Action Wrapper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wrap a command action to ensure global options are resolved.
 * This guarantees flags like --quiet, --no-color work consistently.
 *
 * @example
 * ```ts
 * program
 *   .command('mycommand')
 *   .action(withGlobals(program, async (ctx, arg) => {
 *     if (!ctx.globals.quiet) console.log('Running...');
 *   }));
 * ```
 */
export function withGlobals<TArgs extends unknown[]>(
  program: Command,
  fn: (ctx: ActionContext, ...args: TArgs) => Promise<void> | void
): (...args: TArgs) => Promise<void> | void {
  return (...args: TArgs) => {
    const globals = resolveGlobalOptions(program.opts());
    return fn({ globals }, ...args);
  };
}
