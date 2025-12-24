/**
 * File walker implementation.
 * Walks collection directories using Bun.Glob with include/exclude filtering.
 *
 * @module src/ingestion/walker
 */

import { extname, normalize as normalizePath, sep } from 'node:path';
import type { SkippedEntry, WalkConfig, WalkEntry, WalkerPort } from './types';

/**
 * Normalize path to POSIX format (forward slashes).
 */
function toPosixPath(path: string): string {
  if (sep === '/') {
    return path;
  }
  return path.replaceAll(sep, '/');
}

/**
 * Check if a path matches any exclude pattern.
 * Exclude patterns can match:
 * - Exact directory/file name: ".git" matches ".git" or "foo/.git/bar"
 * - Path prefix: "node_modules" matches "node_modules/..." or "foo/node_modules/..."
 */
function matchesExclude(relPath: string, excludes: string[]): boolean {
  const parts = relPath.split('/');

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
 */
function matchesInclude(relPath: string, include: string[]): boolean {
  if (include.length === 0) {
    return true;
  }

  const ext = extname(relPath).toLowerCase();
  if (!ext) {
    return false;
  }

  return include.some((inc) => {
    const normalizedInc = inc.startsWith('.')
      ? inc.toLowerCase()
      : `.${inc.toLowerCase()}`;
    return ext === normalizedInc;
  });
}

/**
 * File walker implementation using Bun.Glob.
 */
export class FileWalker implements WalkerPort {
  async walk(config: WalkConfig): Promise<{
    entries: WalkEntry[];
    skipped: SkippedEntry[];
  }> {
    const entries: WalkEntry[] = [];
    const skipped: SkippedEntry[] = [];

    const glob = new Bun.Glob(config.pattern);

    for await (const match of glob.scan({
      cwd: config.root,
      absolute: true,
      onlyFiles: true,
      followSymlinks: false,
    })) {
      // Compute relative path
      const absPath = normalizePath(match);
      let relPath = absPath.slice(config.root.length);
      if (relPath.startsWith('/') || relPath.startsWith(sep)) {
        relPath = relPath.slice(1);
      }
      relPath = toPosixPath(relPath);

      // Check exclude patterns
      if (matchesExclude(relPath, config.exclude)) {
        continue; // Silently skip excluded files
      }

      // Check include extensions
      if (!matchesInclude(relPath, config.include)) {
        continue; // Silently skip non-matching extensions
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
          reason: 'TOO_LARGE',
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
