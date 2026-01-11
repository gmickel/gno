/**
 * File walker implementation.
 * Walks collection directories using Bun.Glob with include/exclude filtering.
 *
 * @module src/ingestion/walker
 */

// node:fs/promises - Bun has no realpath equivalent
import { realpath } from "node:fs/promises";
// node:path - Bun has no path manipulation module
import {
  extname,
  isAbsolute,
  normalize as normalizePath,
  relative,
  resolve,
  sep,
} from "node:path";

import type { SkippedEntry, WalkConfig, WalkEntry, WalkerPort } from "./types";

import { SUPPORTED_EXTENSIONS } from "../converters/mime";

/**
 * Regex to detect dangerous patterns with parent directory traversal.
 * Matches ".." at start, after "/", or after "\" (Windows).
 */
const DANGEROUS_PATTERN_REGEX = /(?:^|[\\/])\.\./;

/**
 * Normalize path to POSIX format (forward slashes).
 */
function toPosixPath(path: string): string {
  if (sep === "/") {
    return path;
  }
  return path.replaceAll(sep, "/");
}

/**
 * Validate glob pattern is safe (no directory traversal).
 * Returns error message if invalid, null if valid.
 */
function validatePattern(pattern: string): string | null {
  if (isAbsolute(pattern)) {
    return "Pattern must be relative, not absolute";
  }
  if (DANGEROUS_PATTERN_REGEX.test(pattern)) {
    return "Pattern contains dangerous parent directory reference (..)";
  }
  return null;
}

/**
 * Compute safe relative path from root to file.
 * Returns null if file is outside root (security check).
 * Uses realpath to resolve symlinks and normalize case.
 */
async function safeRelPath(
  rootReal: string,
  absPath: string
): Promise<string | null> {
  try {
    const fileReal = await realpath(absPath);
    const rel = relative(rootReal, fileReal);

    // Reject if relative path escapes root
    // Check for ".." at start followed by separator or end (not just ".." prefix)
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return null;
    }

    return toPosixPath(rel);
  } catch {
    // Can't resolve path (e.g., broken symlink)
    return null;
  }
}

/**
 * Check if a path matches any exclude pattern.
 *
 * Exclude semantics (component-based matching):
 * - Patterns match against path components (directory/file names)
 * - "node_modules" matches any path containing "node_modules" as a component
 * - ".git" matches ".git" directory at any level
 * - Patterns are NOT globs - they match exact component names
 *
 * Examples:
 * - exclude: [".git"] matches "foo/.git/bar" but not "foo/.github/..."
 * - exclude: ["dist"] matches "dist/bundle.js" and "src/dist/output.js"
 */
function matchesExclude(relPath: string, excludes: string[]): boolean {
  const parts = relPath.split("/");

  for (const pattern of excludes) {
    // Check if any path component matches exactly
    if (parts.includes(pattern)) {
      return true;
    }
    // Check if path starts with pattern
    if (relPath.startsWith(`${pattern}/`)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a file extension matches the include list.
 * Include list contains extensions like ".md" or "md" (normalized).
 * When include is empty, falls back to SUPPORTED_EXTENSIONS to avoid
 * walking files that can't be converted.
 */
function matchesInclude(relPath: string, include: string[]): boolean {
  const ext = extname(relPath).toLowerCase();
  if (!ext) {
    return false;
  }

  // Fallback to supported extensions when no explicit include list
  const effectiveInclude =
    include.length === 0 ? SUPPORTED_EXTENSIONS : include;

  return effectiveInclude.some((inc) => {
    const normalizedInc = inc.startsWith(".")
      ? inc.toLowerCase()
      : `.${inc.toLowerCase()}`;
    return ext === normalizedInc;
  });
}

/**
 * File walker implementation using Bun.Glob.
 *
 * Security: Validates patterns and ensures all matched files are within
 * the collection root directory. Files outside root are silently ignored.
 */
export class FileWalker implements WalkerPort {
  async walk(config: WalkConfig): Promise<{
    entries: WalkEntry[];
    skipped: SkippedEntry[];
  }> {
    const entries: WalkEntry[] = [];
    const skipped: SkippedEntry[] = [];

    // Validate pattern for security
    const patternError = validatePattern(config.pattern);
    if (patternError) {
      throw new Error(`Invalid glob pattern: ${patternError}`);
    }

    // Resolve root to real path for consistent comparison
    const rootAbs = resolve(config.root);
    let rootReal: string;
    try {
      rootReal = await realpath(rootAbs);
    } catch {
      // Root doesn't exist
      return { entries: [], skipped: [] };
    }

    const glob = new Bun.Glob(config.pattern);

    for await (const match of glob.scan({
      cwd: rootReal,
      absolute: true,
      onlyFiles: true,
      followSymlinks: false,
    })) {
      const absPath = normalizePath(match);

      // Security: Compute safe relative path (validates file is within root)
      const relPath = await safeRelPath(rootReal, absPath);
      if (relPath === null) {
        // File outside root or unresolvable - silently skip (security)
        continue;
      }

      // Check exclude patterns
      if (matchesExclude(relPath, config.exclude)) {
        skipped.push({
          absPath,
          relPath,
          reason: "EXCLUDED",
        });
        continue;
      }

      // Check include extensions
      if (!matchesInclude(relPath, config.include)) {
        skipped.push({
          absPath,
          relPath,
          reason: "EXCLUDED",
        });
        continue;
      }

      // Stat file
      const file = Bun.file(absPath);
      let stat: { size: number; mtime: Date };
      try {
        stat = await file.stat();
      } catch {
        // Can't stat file, skip silently
        continue;
      }

      // Check maxBytes BEFORE reading
      if (stat.size > config.maxBytes) {
        skipped.push({
          absPath,
          relPath,
          reason: "TOO_LARGE",
          size: stat.size,
        });
        continue;
      }

      entries.push({
        absPath,
        relPath,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      });
    }

    // Sort entries by relPath for deterministic output
    entries.sort((a, b) => a.relPath.localeCompare(b.relPath));

    return { entries, skipped };
  }
}

/**
 * Default walker instance.
 */
export const defaultWalker = new FileWalker();
