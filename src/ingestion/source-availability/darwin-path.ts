/**
 * Metadata-free recognition of the macOS File Provider layouts covered by the
 * physical fn-118 evidence. This is intentionally narrower than all paths on
 * Darwin: unknown storage must not inherit a no-materialization guarantee.
 */

// node:os — Bun has no home-directory helper.
import { homedir } from "node:os";
// node:path — Bun has no path normalization/relative helpers.
import { isAbsolute, relative, resolve, sep } from "node:path";

export type DarwinFileProviderPathSupport =
  | "google-drive"
  | "icloud-drive"
  | "onedrive-sharepoint"
  | "unsupported"
  | "unknown";

export function classifyDarwinFileProviderPath(
  absPath: string,
  home: string = homedir()
): DarwinFileProviderPathSupport {
  if (!isAbsolute(absPath) || !isAbsolute(home)) {
    return "unknown";
  }
  const relativeHomePath = relative(resolve(home), resolve(absPath));
  if (
    relativeHomePath === ".." ||
    relativeHomePath.startsWith(`..${sep}`) ||
    isAbsolute(relativeHomePath)
  ) {
    return "unsupported";
  }
  const parts = relativeHomePath.split(sep);
  if (
    parts[0] === "Library" &&
    parts[1] === "Mobile Documents" &&
    parts[2] === "com~apple~CloudDocs"
  ) {
    return "icloud-drive";
  }
  if (parts[0] !== "Library" || parts[1] !== "CloudStorage") {
    return "unsupported";
  }
  const domain = parts[2];
  if (domain?.startsWith("GoogleDrive-") && parts[3] === "My Drive") {
    return "google-drive";
  }
  if (
    domain?.startsWith("OneDrive-") &&
    domain.includes("SharedLibraries") &&
    typeof parts[3] === "string" &&
    parts[3].length > 0
  ) {
    return "onedrive-sharepoint";
  }
  return "unsupported";
}
