/**
 * CLI output utilities with policy-based routing.
 * Implements stdout/stderr discipline per clig.dev guidelines:
 * - stdout: data output (for piping/scripting)
 * - stderr: messaging, progress, hints (for humans)
 *
 * @module src/cli/ui
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type OutputPolicy = {
  quiet: boolean;
  json: boolean;
  isTTY: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Policy Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if hints/progress should be shown based on output policy.
 * Hints are suppressed when: quiet mode, JSON mode, or non-TTY.
 */
export function shouldShowHints(policy: OutputPolicy): boolean {
  return !(policy.quiet || policy.json) && policy.isTTY;
}

/**
 * Create output policy from global options.
 */
export function createOutputPolicy(opts: {
  quiet: boolean;
  json: boolean;
}): OutputPolicy {
  return {
    quiet: opts.quiet,
    json: opts.json,
    isTTY: process.stderr.isTTY ?? false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Output Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write data to stdout (for piping/scripting).
 * Not affected by quiet mode - data is always emitted.
 */
export function data(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

/**
 * Write info message to stderr.
 * Not affected by quiet mode - important messages are always shown.
 */
export function info(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

/**
 * Write error message to stderr.
 * Not affected by quiet mode - errors are always shown.
 */
export function error(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

/**
 * Write hint/progress message to stderr (gated by policy).
 * Suppressed in quiet mode, JSON mode, or non-TTY.
 */
export function hint(msg: string, policy: OutputPolicy): void {
  if (shouldShowHints(policy)) {
    process.stderr.write(`${msg}\n`);
  }
}

/**
 * Write warning message to stderr (gated by quiet only).
 * Shown unless explicitly silenced with --quiet.
 */
export function warn(msg: string, policy: OutputPolicy): void {
  if (!policy.quiet) {
    process.stderr.write(`${msg}\n`);
  }
}
