/**
 * Shared CLI global options state.
 * Extracted from src/cli/program so commands and runners do not pull in
 * Commander or the full command definition tree just to read/reset globals.
 *
 * @module src/cli/globals
 */

import type { GlobalOptions } from "./context";

import { setColorsEnabled } from "./colors";

const globalState: { current: GlobalOptions | null } = { current: null };
let cliInvocationActive = false;
const resetListeners = new Set<() => void>();

/** Register a cleanup hook invoked when CLI global state resets. */
export function registerGlobalsResetListener(listener: () => void): void {
  resetListeners.add(listener);
}

/** Mark that a CLI invocation is active (enables per-invocation caches). */
export function setCliInvocationActive(active: boolean): void {
  cliInvocationActive = active;
  if (!active) {
    for (const listener of resetListeners) {
      listener();
    }
  }
}

/** True while inside an active runCli() invocation. */
export function isCliInvocationActive(): boolean {
  return cliInvocationActive || globalState.current !== null;
}

/** Set resolved global options (called by Commander's preAction hook). */
export function setGlobals(globals: GlobalOptions): void {
  globalState.current = globals;
}

/**
 * Get resolved global options. Must be called after command parsing.
 * Throws if called before preAction hook runs.
 */
export function getGlobals(): GlobalOptions {
  if (!globalState.current) {
    throw new Error("Global options not resolved - called before preAction?");
  }
  return globalState.current;
}

/**
 * Reset global state (for testing and at the start of every CLI invocation).
 * Resets option state, color state, and per-invocation caches.
 */
export function resetGlobals(): void {
  globalState.current = null;
  cliInvocationActive = false;
  setColorsEnabled(true);
  for (const listener of resetListeners) {
    listener();
  }
}
