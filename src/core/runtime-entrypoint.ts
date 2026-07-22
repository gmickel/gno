/** Canonical entrypoint for the GNO package executing this process. */

// node:path has no Bun equivalent for portable absolute path resolution.
import { posix, win32 } from "node:path";

/** Resolve the stable package entrypoint for a core-module directory. */
export function resolveGnoEntrypoint(
  coreModuleDir: string,
  platformName: NodeJS.Platform = process.platform
): string {
  const pathApi = platformName === "win32" ? win32 : posix;
  return pathApi.resolve(coreModuleDir, "../index.ts");
}

/**
 * Resolve the CLI entrypoint beside the currently loaded GNO runtime.
 *
 * This remains stable for source checkouts, globally installed npm packages,
 * packed installs, and the staged desktop runtime because all ship `src/` with
 * the same layout.
 */
export function getCurrentGnoEntrypoint(): string {
  return resolveGnoEntrypoint(import.meta.dir);
}
