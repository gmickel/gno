/**
 * Version-independent launch paths for client registrations (fn-213).
 *
 * `process.execPath` and the GNO entrypoint are absolute, and under a
 * version manager they sit in a versioned install directory
 * (`installs/bun/1.3.14/...`, `Cellar/bun/1.4.2/...`). A registration that
 * names that directory keeps starting the old runtime after an upgrade, and
 * fails once the version is removed. Each manager also keeps a link that
 * follows its upgrades; a registration names that link instead, but only
 * when it resolves to the very file in use now. Shims that pick a version
 * from the shell environment (asdf, proto, mise shims) are never used: GUI
 * clients start servers without that environment.
 *
 * @module src/cli/commands/mcp/launch-path
 */

// node:fs realpathSync: synchronous link resolution; Bun has no realpath API.
import { realpathSync } from "node:fs";

/** mise, asdf and proto: `<root>/{installs,tools}/bun/<version>/...`. */
const MANAGER_VERSION_DIR = /([\\/])(installs|tools)\1bun\1([^\\/]+)(?=[\\/])/;
/** Homebrew: `<prefix>/Cellar/bun/<version>/...`. */
const HOMEBREW_VERSION_DIR = /([\\/])Cellar\1bun\1[^\\/]+(?=[\\/])/;
/** Version-independent directory names a manager keeps itself. */
const ALIAS_VERSIONS = new Set(["latest", "current", "system"]);

/**
 * The version-independent links a manager keeps for `path`, or null when
 * `path` is not inside a versioned install directory.
 */
export function versionIndependentCandidates(path: string): string[] | null {
  const cellar = HOMEBREW_VERSION_DIR.exec(path);
  if (cellar) {
    const separator = cellar[1] ?? "/";
    return [
      path.replace(HOMEBREW_VERSION_DIR, `${separator}opt${separator}bun`),
    ];
  }
  const manager = MANAGER_VERSION_DIR.exec(path);
  if (!manager || ALIAS_VERSIONS.has(manager[3] ?? "")) {
    return null;
  }
  const separator = manager[1] ?? "/";
  return [
    path.replace(
      MANAGER_VERSION_DIR,
      `${separator}${manager[2]}${separator}bun${separator}latest`
    ),
  ];
}

const realpathOrNull = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

export interface LaunchPath {
  /** The path to write. */
  path: string;
  /**
   * True when `path` is inside a versioned install directory and no
   * version-independent link resolves to it: the registration stays on this
   * version until it is reinstalled.
   */
  pinned: boolean;
}

/** Prefer a version-independent link that resolves to the same file. */
export function stableLaunchPath(
  path: string,
  realpath: (path: string) => string | null = realpathOrNull
): LaunchPath {
  const candidates = versionIndependentCandidates(path);
  if (!candidates) {
    return { path, pinned: false };
  }
  const target = realpath(path);
  for (const candidate of candidates) {
    if (target !== null && realpath(candidate) === target) {
      return { path: candidate, pinned: false };
    }
  }
  return { path, pinned: true };
}
