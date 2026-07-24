/**
 * Canonical cross-process lock identity for all config writers.
 *
 * @module src/core/config-write-lock
 */

// node:fs/promises provides realpath; Bun has no equivalent for canonical path identity.
import { realpath } from "node:fs/promises";
// node:path provides structural path operations; Bun has no path utilities.
import { basename, dirname, resolve } from "node:path";

/**
 * Resolve an existing path, or resolve its nearest existing ancestor while
 * retaining unresolved path components. This makes aliases of the same config
 * file converge before the file exists and after it is created.
 */
export async function canonicalOperationalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  const unresolved: string[] = [];
  let candidate = absolute;

  while (true) {
    try {
      return resolve(await realpath(candidate), ...unresolved.reverse());
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return absolute;
      unresolved.push(basename(candidate));
      candidate = parent;
    }
  }
}

/** One stable sibling lock for every writer of the selected config file. */
export async function resolveConfigWriteTarget(
  configPath: string
): Promise<{ configPath: string; lockPath: string }> {
  const canonicalConfigPath = await canonicalOperationalPath(configPath);
  return {
    configPath: canonicalConfigPath,
    lockPath: `${canonicalConfigPath}.write.lock`,
  };
}

export async function getConfigWriteLockPath(
  configPath: string
): Promise<string> {
  return (await resolveConfigWriteTarget(configPath)).lockPath;
}
