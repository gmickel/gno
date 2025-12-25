/**
 * Global CLI context resolution.
 * Handles global options, NO_COLOR support, etc.
 *
 * @module src/cli/context
 */

import { setColorsEnabled } from './colors';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type GlobalOptions = {
  index: string;
  config?: string;
  color: boolean;
  verbose: boolean;
  yes: boolean;
  quiet: boolean;
  json: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve global options from Commander raw opts.
 * Supports NO_COLOR env var (https://no-color.org/).
 */
export function resolveGlobalOptions(
  raw: Record<string, unknown>,
  env = process.env
): GlobalOptions {
  // NO_COLOR env var support (https://no-color.org/)
  const noColorEnv = env.NO_COLOR !== undefined && env.NO_COLOR !== '';
  // --no-color sets color to false in Commander
  const noColorFlag = raw.color === false;

  const colorEnabled = !(noColorEnv || noColorFlag);

  // Set colors state (enables per-invocation reset, avoids test pollution)
  setColorsEnabled(colorEnabled);

  return {
    index: (raw.index as string) ?? 'default',
    config: raw.config as string | undefined,
    color: colorEnabled,
    verbose: Boolean(raw.verbose),
    yes: Boolean(raw.yes),
    quiet: Boolean(raw.quiet),
    json: Boolean(raw.json),
  };
}
