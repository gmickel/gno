/**
 * Shared validation helpers for MCP and Web UI.
 *
 * @module src/core/validation
 */

// node:fs/promises for realpath (no Bun equivalent)
import { realpath } from "node:fs/promises";
// node:os for homedir (no Bun os utils)
import { homedir } from "node:os";
// node:path for path utils (no Bun path utils)
import { isAbsolute, join, normalize, sep } from "node:path";

import { toAbsolutePath } from "../config/paths";

const DANGEROUS_ROOT_PATTERNS = [
  "/",
  homedir(),
  "/etc",
  "/usr",
  "/bin",
  "/var",
  "/System",
  "/Library",
  join(homedir(), ".config"),
  join(homedir(), ".local"),
  join(homedir(), ".ssh"),
  join(homedir(), ".gnupg"),
];

async function resolveRealPathSafe(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

export function normalizeCollectionName(name: string): string {
  return name.trim().toLowerCase();
}

export function validateRelPath(relPath: string): string {
  if (isAbsolute(relPath)) {
    throw new Error("relPath must be relative");
  }
  if (relPath.includes("\0")) {
    throw new Error("relPath contains invalid characters");
  }

  const normalized = normalize(relPath);
  const segments = normalized.split(sep);
  if (segments.includes("..")) {
    throw new Error("relPath cannot escape collection root");
  }

  return normalized;
}

export async function validateCollectionRoot(
  inputPath: string
): Promise<string> {
  const absPath = toAbsolutePath(inputPath);
  const realPath = await resolveRealPathSafe(absPath);

  const dangerousRoots = await Promise.all(
    DANGEROUS_ROOT_PATTERNS.map((p) => resolveRealPathSafe(p))
  );

  if (dangerousRoots.includes(realPath)) {
    throw new Error(`Cannot add ${inputPath}: resolves to dangerous root`);
  }

  return realPath;
}
