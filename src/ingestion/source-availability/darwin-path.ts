/**
 * Metadata-free recognition of the macOS File Provider layouts covered by the
 * physical evidence in research/file-provider/ (fn-118; Google Shared drives in
 * fn-179). This is intentionally narrower than all paths on
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

let cachedHomeRaw: string | undefined;
let cachedHomeResolved: string | undefined;

function resolveHomeDir(home?: string): string {
  const raw = home ?? homedir();
  if (raw === cachedHomeRaw && cachedHomeResolved !== undefined) {
    return cachedHomeResolved;
  }
  const resolved = resolve(raw);
  if (home === undefined) {
    cachedHomeRaw = raw;
    cachedHomeResolved = resolved;
  }
  return resolved;
}

export function classifyDarwinFileProviderPath(
  absPath: string,
  home?: string
): DarwinFileProviderPathSupport {
  const homeRaw = home ?? homedir();
  if (!isAbsolute(absPath) || !isAbsolute(homeRaw)) {
    return "unknown";
  }
  const resolvedHome = home === undefined ? resolveHomeDir() : resolve(homeRaw);
  const relativeHomePath = relative(resolvedHome, resolve(absPath));
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
  if (domain?.startsWith("GoogleDrive-")) {
    const isMyDrive = parts[3] === "My Drive";
    const isSharedDrive =
      parts[3] === "Shared drives" &&
      typeof parts[4] === "string" &&
      parts[4].length > 0;
    return isMyDrive || isSharedDrive ? "google-drive" : "unsupported";
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
