// node:fs: sync existence checks for packaged runtime files (no Bun equivalent).
import { existsSync } from "node:fs";
// node:path: cross-platform path joins for packaged app layouts.
import { dirname, join, posix, resolve, win32 } from "node:path";

export const DEFAULT_GNO_RUNTIME_FOLDER = "gno-runtime";

export function getResourcesFolder(
  execPath: string = process.execPath,
  platformName: NodeJS.Platform = process.platform
): string {
  if (platformName === "win32") {
    return win32.join(win32.dirname(execPath), "resources");
  }
  if (platformName === "darwin") {
    const execDir = posix.dirname(execPath);
    return posix.resolve(execDir, "../Resources");
  }
  const execDir = dirname(execPath);
  return resolve(execDir, "resources");
}

export function getPackagedRuntimeDir(
  resourcesFolder: string,
  runtimeFolder: string = DEFAULT_GNO_RUNTIME_FOLDER
): string {
  return join(resourcesFolder, "app", runtimeFolder);
}

export function getPackagedRuntimeEntrypoint(
  resourcesFolder: string,
  runtimeFolder: string = DEFAULT_GNO_RUNTIME_FOLDER
): string {
  return join(
    getPackagedRuntimeDir(resourcesFolder, runtimeFolder),
    "src",
    "index.ts"
  );
}

export function hasPackagedRuntime(
  resourcesFolder: string,
  runtimeFolder: string = DEFAULT_GNO_RUNTIME_FOLDER
): boolean {
  return existsSync(
    getPackagedRuntimeEntrypoint(resourcesFolder, runtimeFolder)
  );
}

export function getBundledBunPath(
  execPath: string = process.execPath,
  platformName: NodeJS.Platform = process.platform
): string {
  if (platformName === "win32") {
    return win32.join(win32.dirname(execPath), "bun.exe");
  }
  if (platformName === "darwin") {
    return posix.join(posix.dirname(execPath), "bun");
  }
  return join(dirname(execPath), "bun");
}
