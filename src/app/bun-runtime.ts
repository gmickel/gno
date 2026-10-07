/**
 * Minimum supported Bun (fn-213).
 *
 * `engines.bun` in package.json is the single source of truth. Bun 1.4.0
 * and 1.4.1 fixed structured-clone bugs in the path worker messages take,
 * which can crash a long-running process; older runtimes still start, but
 * `serve`, `daemon` and `mcp` say so once on stderr.
 *
 * @module src/app/bun-runtime
 */

import pkg from "../../package.json";

/** Supported Bun range, e.g. `>=1.4.1`. */
export const BUN_ENGINE_RANGE: string = pkg.engines.bun;

/** The minimum version in that range, e.g. `1.4.1`. */
export const BUN_FLOOR: string = BUN_ENGINE_RANGE.replace(/^>=\s*/, "");

/** Whether a Bun version is within the supported range. */
export function bunMeetsFloor(version: string = Bun.version): boolean {
  return Bun.semver.satisfies(version, BUN_ENGINE_RANGE);
}

/** One-line warning for a command started on an unsupported Bun, else null. */
export function bunFloorWarning(
  command: string,
  version: string = Bun.version
): string | null {
  if (bunMeetsFloor(version)) return null;
  return `gno ${command}: running on Bun ${version}, older than the supported minimum ${BUN_FLOOR}; older runtimes can crash long-running processes. Upgrade Bun and restart.`;
}

/** Print the warning for `command` when the running Bun is unsupported. */
export function warnIfBunBelowFloor(
  command: string,
  write: (line: string) => void = console.warn
): void {
  const warning = bunFloorWarning(command);
  if (warning) write(warning);
}
