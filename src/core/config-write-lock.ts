/**
 * Canonical cross-process lock identity for all config writers.
 *
 * @module src/core/config-write-lock
 */

// node:fs/promises provides symlink-aware path operations; Bun has no equivalent for canonical path identity.
import { lstat, readlink, realpath } from "node:fs/promises";
// node:path provides structural path operations; Bun has no path utilities.
import { basename, dirname, isAbsolute, resolve } from "node:path";

import { expandPath } from "../config/paths";

const MISSING_PATH_ERROR_CODES = new Set(["ENOENT", "ENOTDIR"]);

function isMissingPathError(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    "code" in cause &&
    typeof cause.code === "string" &&
    MISSING_PATH_ERROR_CODES.has(cause.code)
  );
}

async function canonicalizeProspectivePath(
  absolutePath: string,
  seenLinks: Set<string>
): Promise<string> {
  const unresolved: string[] = [];
  let candidate = absolutePath;

  while (true) {
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) {
        if (seenLinks.has(candidate)) {
          throw new Error(`Config path contains a symlink loop: ${candidate}`);
        }
        seenLinks.add(candidate);

        const linkTarget = await readlink(candidate);
        const absoluteTarget = isAbsolute(linkTarget)
          ? linkTarget
          : resolve(dirname(candidate), linkTarget);
        const canonicalTarget = await canonicalizeProspectivePath(
          absoluteTarget,
          seenLinks
        );
        return resolve(canonicalTarget, ...unresolved.reverse());
      }

      const canonicalAncestor = await realpath(candidate);
      return resolve(canonicalAncestor, ...unresolved.reverse());
    } catch (cause) {
      if (!isMissingPathError(cause)) throw cause;

      const parent = dirname(candidate);
      if (parent === candidate) return absolutePath;
      unresolved.push(basename(candidate));
      candidate = parent;
    }
  }
}

/**
 * Resolve an existing path, or resolve its nearest existing ancestor while
 * retaining unresolved path components. This makes aliases of the same config
 * file converge before the file exists and after it is created.
 */
export async function canonicalOperationalPath(path: string): Promise<string> {
  return canonicalizeProspectivePath(resolve(expandPath(path)), new Set());
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
