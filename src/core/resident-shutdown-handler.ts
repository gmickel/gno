/**
 * Whether this process's resident (serve or daemon) has installed its own
 * SIGINT/SIGTERM shutdown handler.
 *
 * A detached resident registers a pid-file cleanup listener before startup,
 * and registering any listener disables the default terminate action. Until
 * the resident's handler exists, that cleanup listener must exit the process
 * itself, or a stop sent during startup is swallowed. Counting listeners
 * cannot tell: the CLI bootstrap and the file processor add their own.
 *
 * @module src/core/resident-shutdown-handler
 */

let installed = false;

/** Called by serve and the daemon right after registering their handlers. */
export function markResidentShutdownHandlerInstalled(): void {
  installed = true;
}

export function residentShutdownHandlerInstalled(): boolean {
  return installed;
}
