/**
 * gno serve command implementation.
 * Start web UI server.
 *
 * @module src/cli/commands/serve
 */

import { warnIfBunBelowFloor } from "../../app/bun-runtime";

export type { ServeOptions, ServeResult } from "../../serve";

/**
 * Execute gno serve command.
 * Server runs until SIGINT/SIGTERM.
 */
export async function serve(
  options: import("../../serve").ServeOptions = {}
): Promise<import("../../serve").ServeResult> {
  warnIfBunBelowFloor("serve");
  const { startServer } = await import("../../serve");
  return startServer(options);
}
