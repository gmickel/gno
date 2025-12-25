/**
 * Global CLI context resolution.
 * Handles global options, NO_COLOR support, etc.
 *
 * @module src/cli/context
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type GlobalOptions = {
  index: string;
  config?: string;
  color: boolean;
  verbose: boolean;
  yes: boolean;
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

  return {
    index: (raw.index as string) ?? 'default',
    config: raw.config as string | undefined,
    color: !(noColorEnv || noColorFlag),
    verbose: Boolean(raw.verbose),
    yes: Boolean(raw.yes),
  };
}
