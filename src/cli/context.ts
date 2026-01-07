/**
 * Global CLI context resolution.
 * Handles global options, NO_COLOR support, etc.
 *
 * @module src/cli/context
 */

import { envIsSet } from "../llm/policy";
import { setColorsEnabled } from "./colors";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface GlobalOptions {
  index: string;
  config?: string;
  color: boolean;
  verbose: boolean;
  yes: boolean;
  quiet: boolean;
  json: boolean;
  offline: boolean;
  noPager: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing (pure - no side effects)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse global options from Commander raw opts (pure function).
 * Supports NO_COLOR env var (https://no-color.org/).
 */
export function parseGlobalOptions(
  raw: Record<string, unknown>,
  env = process.env
): GlobalOptions {
  // NO_COLOR env var support (https://no-color.org/)
  const noColorEnv = env.NO_COLOR !== undefined && env.NO_COLOR !== "";
  // --no-color sets color to false in Commander
  const noColorFlag = raw.color === false;

  const colorEnabled = !(noColorEnv || noColorFlag);

  // Offline mode: --offline flag or HF_HUB_OFFLINE/GNO_OFFLINE env var
  // Use envIsSet for consistent truthiness (treats "1", "true", "yes" as true)
  const offlineEnv =
    envIsSet(env, "HF_HUB_OFFLINE") || envIsSet(env, "GNO_OFFLINE");
  const offlineFlag = Boolean(raw.offline);
  const offlineEnabled = offlineEnv || offlineFlag;

  const noPagerEnv =
    (env.NO_PAGER !== undefined && env.NO_PAGER !== "") ||
    (env.GNO_NO_PAGER !== undefined && env.GNO_NO_PAGER !== "") ||
    env.NODE_ENV === "test" ||
    env.BUN_TEST !== undefined;

  return {
    index: (raw.index as string) ?? "default",
    config: raw.config as string | undefined,
    color: colorEnabled,
    verbose: Boolean(raw.verbose),
    yes: Boolean(raw.yes),
    quiet: Boolean(raw.quiet),
    json: Boolean(raw.json),
    offline: offlineEnabled,
    // Commander: --no-pager => opts().pager === false
    noPager: raw.pager === false || noPagerEnv,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Side Effects
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply global options side effects (colors, etc).
 * Should be called exactly once per CLI invocation.
 */
export function applyGlobalOptions(globals: GlobalOptions): void {
  setColorsEnabled(globals.color);
}
