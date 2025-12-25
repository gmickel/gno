/**
 * Terminal colors with --no-color support.
 *
 * @module src/cli/colors
 */

import pc from 'picocolors';

// Track whether colors are enabled (global state for CLI lifetime)
let colorsEnabled = true;

/**
 * Set colors enabled/disabled.
 * Called by resolveGlobalOptions based on --no-color flag and NO_COLOR env.
 */
export function setColorsEnabled(enabled: boolean): void {
  colorsEnabled = enabled;
}

/**
 * Disable colors (convenience for --no-color).
 */
export function disableColors(): void {
  colorsEnabled = false;
}

/**
 * Check if colors are enabled.
 */
export function areColorsEnabled(): boolean {
  return colorsEnabled;
}

// Wrapper functions that respect --no-color
function wrap(fn: (s: string) => string): (s: string) => string {
  return (s: string) => (colorsEnabled ? fn(s) : s);
}

// Primary styles
export const bold = wrap(pc.bold);
export const dim = wrap(pc.dim);
export const italic = wrap(pc.italic);
export const underline = wrap(pc.underline);

// Text colors
export const red = wrap(pc.red);
export const green = wrap(pc.green);
export const yellow = wrap(pc.yellow);
export const blue = wrap(pc.blue);
export const magenta = wrap(pc.magenta);
export const cyan = wrap(pc.cyan);
export const white = wrap(pc.white);
export const gray = wrap(pc.gray);

// Semantic colors
export const success = wrap(pc.green);
export const warning = wrap(pc.yellow);
export const error = wrap(pc.red);
export const info = wrap(pc.cyan);
export const muted = wrap(pc.gray);

// Combined styles
export const header = (s: string): string => bold(cyan(s));
export const label = (s: string): string => bold(s);
export const path = (s: string): string => underline(s);
