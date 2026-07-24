/** Fail-closed filesystem and environment boundary for installed package smoke. */

// node:fs/promises provides realpath/lstat; Bun has no symlink-safe equivalent.
import { lstat, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_ISOLATED_ENV_PATHS = [
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "GNO_CONFIG_DIR",
  "GNO_DATA_DIR",
  "GNO_CACHE_DIR",
] as const;

const SAFE_PARENT_ENV_KEYS = [
  "CI",
  "COMSPEC",
  "LANG",
  "LC_ALL",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "SystemRoot",
  "TZ",
  "WINDIR",
] as const;

export interface InstalledSetupIsolationOptions {
  tempRoot: string;
  packageRoot: string;
  fixtureDir: string;
  configPath: string;
  dataDir: string;
  env: Record<string, string>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

/**
 * Resolve symlinks through the deepest existing ancestor. This protects paths
 * that do not exist yet without accepting an existing symlink escape.
 */
async function canonicalizeProspectivePath(path: string): Promise<string> {
  const absolute = resolve(path);
  let ancestor = absolute;
  const missingSegments: string[] = [];
  while (!(await exists(ancestor))) {
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      throw new Error("Package smoke isolation could not resolve a path root");
    }
    missingSegments.unshift(basename(ancestor));
    ancestor = parent;
  }

  return resolve(await realpath(ancestor), ...missingSegments);
}

export async function assertPackageSmokePathContained(
  tempRoot: string,
  candidate: string,
  label: string
): Promise<string> {
  if (!(tempRoot.trim() && candidate.trim())) {
    throw new Error(`Package smoke isolation refused empty ${label}`);
  }
  if (!(isAbsolute(tempRoot) && isAbsolute(candidate))) {
    throw new Error(`Package smoke isolation requires absolute ${label}`);
  }

  const canonicalRoot = await realpath(tempRoot);
  const canonicalCandidate = await canonicalizeProspectivePath(candidate);
  const fromRoot = relative(canonicalRoot, canonicalCandidate);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`Package smoke isolation refused outside ${label}`);
  }
  return canonicalCandidate;
}

export async function buildInstalledSetupChildEnv(
  options: InstalledSetupIsolationOptions,
  parentEnv: Record<string, string | undefined> = process.env
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const key of SAFE_PARENT_ENV_KEYS) {
    const value = parentEnv[key];
    if (value) {
      env[key] = value;
    }
  }

  for (const key of REQUIRED_ISOLATED_ENV_PATHS) {
    const value = options.env[key];
    await assertPackageSmokePathContained(options.tempRoot, value ?? "", key);
    env[key] = value ?? "";
  }
  if (options.env.GNO_NO_AUTO_DOWNLOAD !== "1") {
    throw new Error("Package smoke isolation requires GNO_NO_AUTO_DOWNLOAD=1");
  }

  env.GNO_NO_AUTO_DOWNLOAD = "1";
  env.GNO_PACKAGE_SMOKE_TEMP_ROOT = options.tempRoot;
  env.APPDATA = join(options.tempRoot, "appdata");
  env.LOCALAPPDATA = join(options.tempRoot, "local-appdata");
  env.USERPROFILE = options.env.HOME ?? "";
  env.TEMP = options.tempRoot;
  env.TMP = options.tempRoot;
  env.TMPDIR = options.tempRoot;
  env.NO_COLOR = "1";
  return env;
}

const moduleUrl = (packageRoot: string, relativePath: string): string =>
  pathToFileURL(join(packageRoot, relativePath)).href;

/**
 * Verify all explicit and installed-package-derived write paths before any
 * store-backed contract runs.
 */
export async function assertInstalledSetupIsolation(
  options: InstalledSetupIsolationOptions,
  inputPath: string,
  childEnv: Record<string, string | undefined> = process.env
): Promise<void> {
  if (
    childEnv.GNO_PACKAGE_SMOKE_TEMP_ROOT !== options.tempRoot ||
    childEnv.GNO_NO_AUTO_DOWNLOAD !== "1"
  ) {
    throw new Error(
      "Package smoke isolation refused mismatched child environment"
    );
  }
  for (const key of REQUIRED_ISOLATED_ENV_PATHS) {
    if (childEnv[key] !== options.env[key]) {
      throw new Error(
        `Package smoke isolation refused mismatched child ${key}`
      );
    }
  }

  for (const [label, path] of [
    ["packageRoot", options.packageRoot],
    ["fixtureDir", options.fixtureDir],
    ["configPath", options.configPath],
    ["dataDir", options.dataDir],
    ["inputPath", inputPath],
  ] as const) {
    await assertPackageSmokePathContained(options.tempRoot, path, label);
  }

  const constants = (await import(
    moduleUrl(options.packageRoot, "src/app/constants.ts")
  )) as typeof import("../src/app/constants");
  const configPaths = (await import(
    moduleUrl(options.packageRoot, "src/config/paths.ts")
  )) as typeof import("../src/config/paths");
  const dirs = constants.resolveDirs();
  const resolved = configPaths.getConfigPaths(dirs);
  const installedPaths = [
    ["resolved config directory", dirs.config],
    ["resolved data directory", dirs.data],
    ["resolved cache directory", dirs.cache],
    ["resolved config file", resolved.configFile],
    ["resolved data path", resolved.dataDir],
    ["resolved cache path", resolved.cacheDir],
    ["resolved store path", constants.getIndexDbPath("default", dirs)],
    ["resolved model cache", constants.getModelsCachePath(dirs)],
  ] as const;
  for (const [label, path] of installedPaths) {
    await assertPackageSmokePathContained(options.tempRoot, path, label);
  }

  if (
    resolve(options.configPath) !== resolve(resolved.configFile) ||
    resolve(options.dataDir) !== resolve(resolved.dataDir)
  ) {
    throw new Error(
      "Package smoke isolation refused mismatched installed package paths"
    );
  }
}
