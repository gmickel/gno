/**
 * File walker implementation.
 * Walks collection directories using Bun.Glob (`any`) or hierarchical
 * availability-aware descent (`local`).
 *
 * @module src/ingestion/walker
 */

// node:fs - Bun has no synchronous Dirent enumeration for the guarded local walk.
import { readdirSync } from "node:fs";
// node:fs/promises - Bun has no realpath equivalent for symlink-safe containment.
import { lstat, realpath } from "node:fs/promises";
// node:path - Bun has no path manipulation module
import {
  extname,
  isAbsolute,
  join,
  normalize as normalizePath,
  relative,
  resolve,
  sep,
} from "node:path";

import type { SkippedEntry, WalkConfig, WalkEntry, WalkerPort } from "./types";

import { SUPPORTED_EXTENSIONS } from "../converters/mime";
import {
  matchesCollectionExclusion,
  matchesCollectionSubtreeExclusion,
} from "../core/path-rules";
import { isRecordVirtualPath } from "./record-path";
import {
  createDirectoryAvailability,
  type DirectoryAvailabilityPort,
  isUnprovenDirectoryResult,
} from "./source-availability";

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
 * Split GNO's canonical whole-pattern union into independently scannable Bun
 * globs. Bun.Glob.match() accepts a leading `{a,b}` union, but scan() does not.
 * Nested braces remain part of each child glob; escaped outer commas become
 * literal commas again before scanning.
 */
function scanPatterns(pattern: string): string[] {
  if (!(pattern.startsWith("{") && pattern.endsWith("}"))) return [pattern];

  const patterns: string[] = [];
  let branch = "";
  let depth = 0;
  let bracketDepth = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (
      character === "\\" &&
      pattern[index + 1] === "," &&
      depth === 1 &&
      bracketDepth === 0
    ) {
      branch += ",";
      index += 1;
      continue;
    }
    if (character === "[" && bracketDepth === 0) {
      bracketDepth = 1;
      branch += character;
      continue;
    }
    if (character === "]" && bracketDepth > 0) {
      bracketDepth = 0;
      branch += character;
      continue;
    }
    if (bracketDepth > 0) {
      branch += character;
      continue;
    }
    if (character === "{") {
      depth += 1;
      if (depth > 1) branch += character;
      continue;
    }
    if (character === "}") {
      depth -= 1;
      if (depth < 0 || (depth === 0 && index !== pattern.length - 1)) {
        return [pattern];
      }
      if (depth > 0) branch += character;
      continue;
    }
    if (character === "," && depth === 1) {
      patterns.push(branch);
      branch = "";
      continue;
    }
    branch += character;
  }
  if (depth !== 0 || bracketDepth !== 0) return [pattern];
  patterns.push(branch);
  return patterns;
}

/**
 * Compute safe relative path from root to file.
 * Returns null if file is outside root (security check).
 * Uses realpath to resolve symlinks and normalize case.
 */
async function safeRelPath(
  rootReal: string,
  absPath: string
): Promise<{ absPath: string; relPath: string } | null> {
  try {
    const fileReal = await realpath(absPath);
    const rel = relative(rootReal, fileReal);

    // Reject if relative path escapes root
    // Check for ".." at start followed by separator or end (not just ".." prefix)
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return null;
    }

    return { absPath: fileReal, relPath: toPosixPath(rel) };
  } catch {
    // Can't resolve path (e.g., broken symlink)
    return null;
  }
}

/**
 * Check if a file extension matches the include list.
 * Include list contains extensions like ".md" or "md" (normalized).
 * When include is empty, falls back to SUPPORTED_EXTENSIONS plus extensions
 * made convertible by explicit adapter configuration.
 */
function matchesInclude(
  relPath: string,
  include: string[],
  additionalDefaultExtensions: string[]
): boolean {
  const ext = extname(relPath).toLowerCase();
  if (!ext) {
    return false;
  }

  if (include.length === 0 && SUPPORTED_EXTENSIONS.includes(ext)) {
    return true;
  }

  const effectiveInclude =
    include.length === 0 ? additionalDefaultExtensions : include;

  return effectiveInclude.some((inc) => {
    const normalizedInc = inc.startsWith(".")
      ? inc.toLowerCase()
      : `.${inc.toLowerCase()}`;
    return ext === normalizedInc;
  });
}

type PathEligibilityConfig = Pick<
  WalkConfig,
  "additionalDefaultExtensions" | "exclude" | "include" | "pattern"
>;

/**
 * Check collection-relative path eligibility without touching the filesystem.
 * This intentionally remains usable for deleted paths so incremental sync can
 * mark previously indexed documents inactive.
 */
export function matchesWalkPath(
  relPath: string,
  config: PathEligibilityConfig
): boolean {
  const normalizedPath = relPath.replaceAll("\\", "/");
  if (
    isAbsolute(normalizedPath) ||
    DANGEROUS_PATTERN_REGEX.test(normalizedPath) ||
    isRecordVirtualPath(normalizedPath)
  ) {
    return false;
  }

  let matchesPattern = false;
  try {
    matchesPattern = new Bun.Glob(config.pattern).match(normalizedPath);
  } catch {
    return false;
  }
  if (!matchesPattern) {
    return false;
  }

  if (matchesCollectionExclusion(normalizedPath, config.exclude)) {
    return false;
  }

  return matchesInclude(
    normalizedPath,
    config.include,
    config.additionalDefaultExtensions ?? []
  );
}

function pushUnprovenDirectorySkip(
  skipped: SkippedEntry[],
  absPath: string,
  relPath: string,
  result: Exclude<
    Awaited<ReturnType<DirectoryAvailabilityPort["classify"]>>,
    { kind: "available" }
  >
): void {
  skipped.push({
    absPath,
    relPath,
    reason: result.code,
    unprovenPrefix: true,
    message: result.message,
  });
}

/**
 * File walker implementation using Bun.Glob (`any`) or hierarchical local-mode
 * descent that refuses dataless / availability-unknown directories.
 *
 * Security: Validates patterns and ensures all matched files are within
 * the collection root directory. Files outside root are silently ignored.
 */
export class FileWalker implements WalkerPort {
  async walk(config: WalkConfig): Promise<{
    entries: WalkEntry[];
    skipped: SkippedEntry[];
  }> {
    const mode = config.sourceAvailability ?? "any";
    if (mode === "local") {
      return this.walkLocal(config);
    }
    return this.walkAny(config);
  }

  /** Legacy Bun.Glob traversal — behaviorally unchanged for `any`. */
  private async walkAny(config: WalkConfig): Promise<{
    entries: WalkEntry[];
    skipped: SkippedEntry[];
  }> {
    const entries: WalkEntry[] = [];
    const skipped: SkippedEntry[] = [];

    const patterns = scanPatterns(config.pattern);
    for (const pattern of patterns) {
      const patternError = validatePattern(pattern);
      if (patternError) {
        throw new Error(`Invalid glob pattern: ${patternError}`);
      }
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

    const matches = new Set<string>();
    for (const pattern of patterns) {
      const glob = new Bun.Glob(pattern);
      for await (const match of glob.scan({
        cwd: rootReal,
        absolute: true,
        onlyFiles: true,
        followSymlinks: false,
      })) {
        matches.add(normalizePath(match));
      }
    }

    for (const matchedPath of [...matches].sort()) {
      // Security: Compute safe relative path (validates file is within root)
      const safePath = await safeRelPath(rootReal, matchedPath);
      if (safePath === null) {
        // File outside root or unresolvable - silently skip (security)
        continue;
      }
      const { absPath, relPath } = safePath;

      if (!matchesWalkPath(relPath, config)) {
        skipped.push({
          absPath,
          relPath,
          reason: "EXCLUDED",
        });
        continue;
      }

      // Stat file
      const file = Bun.file(absPath);
      let stat: { size: number; mtime: Date; ctime?: Date; birthtime?: Date };
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
        ctime: (stat.birthtime ?? stat.ctime ?? stat.mtime).toISOString(),
      });
    }

    // Sort entries by relPath for deterministic output
    entries.sort((a, b) => a.relPath.localeCompare(b.relPath));

    return { entries, skipped };
  }

  /**
   * Local-mode hierarchical walk: classify each directory before descent.
   * Does not add a per-file availability syscall — content recheck stays at
   * the SourceContentReaderPort boundary.
   */
  private async walkLocal(config: WalkConfig): Promise<{
    entries: WalkEntry[];
    skipped: SkippedEntry[];
  }> {
    const entries: WalkEntry[] = [];
    const skipped: SkippedEntry[] = [];

    for (const pattern of scanPatterns(config.pattern)) {
      const patternError = validatePattern(pattern);
      if (patternError) {
        throw new Error(`Invalid glob pattern: ${patternError}`);
      }
    }

    const rootAbs = resolve(config.root);
    const classifier =
      config.directoryAvailability ??
      createDirectoryAvailability(config.sourceAvailability ?? "local");
    const configuredRootClassified = await classifier.classify(rootAbs);
    if (isUnprovenDirectoryResult(configuredRootClassified)) {
      pushUnprovenDirectorySkip(skipped, rootAbs, "", configuredRootClassified);
      return { entries, skipped };
    }

    let rootReal: string;
    try {
      rootReal = await realpath(rootAbs);
    } catch {
      skipped.push({
        absPath: rootAbs,
        relPath: "",
        reason: "SOURCE_AVAILABILITY_UNKNOWN",
        unprovenPrefix: true,
        message:
          "Collection root could not be resolved after availability check",
      });
      return { entries, skipped };
    }

    if (rootReal !== rootAbs) {
      const canonicalRootClassified = await classifier.classify(rootReal);
      if (isUnprovenDirectoryResult(canonicalRootClassified)) {
        pushUnprovenDirectorySkip(
          skipped,
          rootReal,
          "",
          canonicalRootClassified
        );
        return { entries, skipped };
      }
    }

    const queue: Array<{ absPath: string; relPath: string }> = [
      { absPath: rootReal, relPath: "" },
    ];
    let head = 0;

    while (head < queue.length) {
      const dir = queue[head] as { absPath: string; relPath: string };
      head += 1;

      let dirents;
      try {
        const read = classifier.readDirectory(dir.absPath, () =>
          readdirSync(dir.absPath, { withFileTypes: true })
        );
        if (read.kind !== "available") {
          pushUnprovenDirectorySkip(skipped, dir.absPath, dir.relPath, read);
          continue;
        }
        dirents = read.value;
      } catch {
        skipped.push({
          absPath: dir.absPath,
          relPath: dir.relPath,
          reason: "SOURCE_AVAILABILITY_UNKNOWN",
          unprovenPrefix: true,
          message: "Failed to enumerate directory after availability check",
        });
        continue;
      }

      dirents.sort((left, right) => left.name.localeCompare(right.name));
      for (const dirent of dirents) {
        const name = dirent.name;
        if (name === "" || name === "." || name === "..") {
          continue;
        }
        if (name.includes("\0")) {
          continue;
        }

        const childAbs = join(dir.absPath, name);
        const childRel =
          dir.relPath === "" ? name : `${dir.relPath}/${toPosixPath(name)}`;

        // No-follow: symlinks are leaf candidates so the guarded content open
        // can refuse them with a receipt; never descend through them.
        if (dirent.isSymbolicLink()) {
          if (!matchesWalkPath(childRel, config)) {
            skipped.push({
              absPath: childAbs,
              relPath: childRel,
              reason: "EXCLUDED",
            });
            continue;
          }
          try {
            const linkStat = await lstat(childAbs);
            entries.push({
              absPath: childAbs,
              relPath: childRel,
              size: linkStat.size,
              mtime: linkStat.mtime.toISOString(),
              ctime: (
                linkStat.birthtime ??
                linkStat.ctime ??
                linkStat.mtime
              ).toISOString(),
            });
          } catch {
            skipped.push({
              absPath: childAbs,
              relPath: childRel,
              reason: "SOURCE_AVAILABILITY_UNKNOWN",
              unprovenPrefix: true,
              message: "Symlink metadata changed during local traversal",
            });
          }
          continue;
        }

        if (dirent.isDirectory()) {
          if (matchesCollectionSubtreeExclusion(childRel, config.exclude)) {
            skipped.push({
              absPath: childAbs,
              relPath: childRel,
              reason: "EXCLUDED",
            });
            continue;
          }
          const classified = await classifier.classify(childAbs);
          if (isUnprovenDirectoryResult(classified)) {
            pushUnprovenDirectorySkip(skipped, childAbs, childRel, classified);
            continue;
          }
          queue.push({ absPath: childAbs, relPath: childRel });
          continue;
        }

        if (!dirent.isFile()) {
          continue;
        }

        const safePath = await safeRelPath(rootReal, childAbs);
        if (safePath === null) {
          continue;
        }
        const { absPath, relPath } = safePath;

        if (!matchesWalkPath(relPath, config)) {
          skipped.push({
            absPath,
            relPath,
            reason: "EXCLUDED",
          });
          continue;
        }

        const file = Bun.file(absPath);
        let fileStat: {
          size: number;
          mtime: Date;
          ctime?: Date;
          birthtime?: Date;
        };
        try {
          fileStat = await file.stat();
        } catch {
          continue;
        }

        if (fileStat.size > config.maxBytes) {
          skipped.push({
            absPath,
            relPath,
            reason: "TOO_LARGE",
            size: fileStat.size,
          });
          continue;
        }

        entries.push({
          absPath,
          relPath,
          size: fileStat.size,
          mtime: fileStat.mtime.toISOString(),
          ctime: (
            fileStat.birthtime ??
            fileStat.ctime ??
            fileStat.mtime
          ).toISOString(),
        });
      }
    }

    entries.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return { entries, skipped };
  }
}

/**
 * Default walker instance.
 */
export const defaultWalker = new FileWalker();
