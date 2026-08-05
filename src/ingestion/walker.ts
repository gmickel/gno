/**
 * File walker implementation.
 * Walks collection directories using Bun.Glob with include/exclude filtering.
 *
 * @module src/ingestion/walker
 */

// node:fs - Stats type for the lstat calls in the no-follow policy below
import type { Stats } from "node:fs";

// node:fs/promises - Bun has no realpath/lstat equivalent
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
import { matchesCollectionExclusion } from "../core/path-rules";
import { isRecordVirtualPath } from "./record-path";

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

/** Errno values that mean "this path does not exist as the thing asked for". */
const MISSING_PATH_ERROR_CODES = new Set(["ENOENT", "ENOTDIR"]);

/** Is this failure "the path is not there", as opposed to "it is unreadable"? */
export function isMissingPathError(cause: unknown): boolean {
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === "string" && MISSING_PATH_ERROR_CODES.has(code);
}

/** One path component below the root, and the identity it had when verified. */
export interface WalkPathComponent {
  absPath: string;
  dev: number;
  ino: number;
}

/**
 * What a collection-relative path turned out to be under `FileWalker.walk`'s
 * NO-FOLLOW policy.
 *
 * `leaf` is the last component's `lstat`, so a caller that needs size/mtime -
 * `syncPaths` does - never has to stat the path a second time. It is `null`
 * only for the collection root, which has no component below the root at all.
 */
export type WalkPathVisibility =
  /** Every component below the root is a real, non-symlink entry. */
  | { status: "visible"; chain: WalkPathComponent[]; leaf: Stats | null }
  /** A component below the root - the leaf, or an ancestor - is a symlink. */
  | { status: "symlink"; absPath: string }
  /** A component is gone, or something that is not a directory stands where a directory must. */
  | { status: "missing" }
  /** The path could not be examined; nothing may be inferred from it. */
  | { status: "error"; cause: unknown };

/** Optional seam for driving the component-by-component window in tests. */
export interface WalkPathVisibilityHooks {
  beforeComponent?: (absPath: string) => void | Promise<void>;
}

/**
 * THE no-follow reachability policy, in one place, for everything that has to
 * agree with `FileWalker.walk`.
 *
 * ## What the walker's policy actually is
 *
 * `walk` canonicalizes the collection ROOT (`realpath`) and then discovers
 * files with `Bun.Glob.scan({ onlyFiles: true, followSymlinks: false })`.
 * Measured, not assumed: with `followSymlinks: false` the scan emits neither a
 * symlink that points at a DIRECTORY nor one that points at a regular FILE, and
 * it never descends through a symlinked directory at any depth. So the policy
 * below the root is uniform and it is not "directories only":
 *
 * > A path is walkable iff no component of it below the collection root - the
 * > leaf included, whatever it points at - is a symlink.
 *
 * The ROOT itself is deliberately exempt: it is legitimately a symlink
 * (`/tmp -> /private/tmp` on macOS), and `walk` resolves it before scanning.
 *
 * ## Why it lives here and not in a caller
 *
 * Every consumer of the index has to reach the SAME conclusion as a full
 * `gno update`, or the watcher and the walker disagree about what is indexed.
 * Enforcing the policy in one enumeration seam is not enough, because a
 * following `stat` elsewhere resurrects the divergence: an indexed document
 * under an alias stats alive and stays active while a full walk deactivates it.
 * So this is applied where ELIGIBILITY is applied - beside `matchesWalkPath` -
 * and both the enumeration seam (`directory-children`) and `syncPaths` consult
 * it. `matchesWalkPath` answers "may this name be indexed"; this answers "can
 * the walker reach it", which is the half that needs the disk.
 *
 * ## The window this does NOT close
 *
 * The check is component-by-component on PATH STRINGS, so it is not atomic. For
 * `a/b`, `a` can be renamed away and replaced by a symlink after `a` has been
 * verified and before `a/b` is `lstat`ed; that `lstat` then traverses the
 * replacement. `chain` carries each verified component's `(dev, ino)` precisely
 * so a caller that goes on to READ through this path can re-prove it afterwards
 * and fail closed. What remains open is a replacement UNDONE before the
 * re-check, and one that preserves `(dev, ino)`. Closing those needs
 * dirfd-relative no-follow traversal (`openat(dirfd, name, O_NOFOLLOW)` +
 * `fdopendir`), and Node/Bun's `fs` exposes no dirfd-relative operations at
 * all, so it cannot be written in this runtime.
 *
 * Never throws.
 *
 * @param rootAbs Absolute collection root. Components are examined BELOW it.
 * @param normalizedRelPath Collection-relative POSIX path, already normalized
 *   (see `normalizeCollectionDirRelPath`). `""` is the root itself.
 */
export async function checkWalkPathVisibility(
  rootAbs: string,
  normalizedRelPath: string,
  hooks?: WalkPathVisibilityHooks
): Promise<WalkPathVisibility> {
  if (normalizedRelPath === "") {
    return { status: "visible", chain: [], leaf: null };
  }
  const segments = normalizedRelPath.split("/");
  const chain: WalkPathComponent[] = [];
  let current = rootAbs;
  let leaf: Stats | null = null;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    let info: Stats;
    try {
      await hooks?.beforeComponent?.(current);
      info = await lstat(current);
    } catch (cause) {
      return isMissingPathError(cause)
        ? { status: "missing" }
        : { status: "error", cause };
    }
    // Asked BEFORE `isDirectory()`: `lstat` reports a symlink as a symlink
    // whatever it points at, which is the whole point of asking no-follow.
    if (info.isSymbolicLink()) {
      return { status: "symlink", absPath: current };
    }
    const isLast = index === segments.length - 1;
    if (!(isLast || info.isDirectory())) {
      // Something that is not a directory stands where a directory component is
      // required - the same thing a following resolution reports as ENOTDIR.
      return { status: "missing" };
    }
    chain.push({ absPath: current, dev: info.dev, ino: info.ino });
    leaf = info;
  }
  return { status: "visible", chain, leaf };
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
}

/**
 * Default walker instance.
 */
export const defaultWalker = new FileWalker();
