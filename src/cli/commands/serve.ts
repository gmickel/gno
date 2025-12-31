/**
 * gno serve command implementation.
 * Start web UI server.
 *
 * @module src/cli/commands/serve
 */

export type { ServeOptions, ServeResult } from '../../serve';

/**
 * Execute gno serve command.
 * Server runs until SIGINT/SIGTERM.
 */
export async function serve(options: ServeOptions = {}): Promise<ServeResult> {
  const { startServer } = await import('../../serve');
  return startServer(options);
}
