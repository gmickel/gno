// node:fs - Bun has no synchronous Dirent enumeration for the guarded local walk.
import { readdirSync } from "node:fs";
/**
 * File walker implementation.
 * Walks collection directories using bounded async readdir with subtree pruning
 * (`any`) or hierarchical availability-aware descent (`local`).
 *
 * @module src/ingestion/walker
 */
// node:fs/promises - Bun has no realpath/lstat/readdir(withFileTypes) equivalents.
import { lstat, readdir, realpath } from "node:fs/promises";
// node:path - Bun has no path manipulation module
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { SkippedEntry, WalkConfig, WalkEntry, WalkerPort } from "./types";

import { SUPPORTED_EXTENSIONS } from "../converters/mime";
import {
  type CompiledCollectionExclusions,
  compileCollectionExclusions,
  matchesCompiledExclusion,
  matchesCompiledSubtreeExclusion,
} from "../core/path-rules";
import { isCompiledContextPath } from "./compiled-context";
import { isRecordVirtualPath } from "./record-path";
import {
  createDirectoryAvailability,
  type DirectoryAvailabilityPort,
  isUnprovenDirectoryResult,
} from "./source-availability";

/** Bounded concurrency for file.stat() batches and async directory reads. */
const STAT_CONCURRENCY = 32;
const READDIR_CONCURRENCY = 16;

/** Detects whether a glob pattern explicitly references a dotfile/dotdir segment. */
const EXPLICIT_DOT_PATTERN = /(?:^|[\\/{,])\./;

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

type PathEligibilityConfig = Pick<
  WalkConfig,
  "additionalDefaultExtensions" | "exclude" | "include" | "pattern"
>;

interface CompiledWalkMatcher {
  patternGlob: Bun.Glob | null;
  exclusions: CompiledCollectionExclusions;
  includeExtensions: ReadonlySet<string>;
}

const DEFAULT_SUPPORTED_EXTENSION_SET = new Set(
  SUPPORTED_EXTENSIONS.map((ext) => ext.toLowerCase())
);

/** Pre-compile glob, exclusion rules, and extension set once per walk. */
function compileWalkMatcher(
  config: PathEligibilityConfig
): CompiledWalkMatcher {
  let patternGlob: Bun.Glob | null = null;
  try {
    patternGlob = new Bun.Glob(config.pattern);
  } catch {
    patternGlob = null;
  }
  const exclusions = compileCollectionExclusions(config.exclude);
  let includeExtensions: ReadonlySet<string>;
  if (config.include.length === 0) {
    const extra = config.additionalDefaultExtensions ?? [];
    if (extra.length === 0) {
      includeExtensions = DEFAULT_SUPPORTED_EXTENSION_SET;
    } else {
      const merged = new Set(DEFAULT_SUPPORTED_EXTENSION_SET);
      for (const inc of extra) {
        const lower = inc.toLowerCase();
        merged.add(lower.startsWith(".") ? lower : `.${lower}`);
      }
      includeExtensions = merged;
    }
  } else {
    const explicit = new Set<string>();
    for (const inc of config.include) {
      const lower = inc.toLowerCase();
      explicit.add(lower.startsWith(".") ? lower : `.${lower}`);
    }
    includeExtensions = explicit;
  }
  return { patternGlob, exclusions, includeExtensions };
}

function matchesCompiledWalkPath(
  relPath: string,
  matcher: CompiledWalkMatcher
): boolean {
  const normalizedPath = relPath.includes("\\")
    ? relPath.replaceAll("\\", "/")
    : relPath;
  if (
    isAbsolute(normalizedPath) ||
    DANGEROUS_PATTERN_REGEX.test(normalizedPath) ||
    isRecordVirtualPath(normalizedPath) ||
    isCompiledContextPath(normalizedPath)
  ) {
    return false;
  }
  if (!matcher.patternGlob?.match(normalizedPath)) {
    return false;
  }
  if (matchesCompiledExclusion(normalizedPath, matcher.exclusions)) {
    return false;
  }
  const ext = extname(normalizedPath).toLowerCase();
  if (!ext) {
    return false;
  }
  return matcher.includeExtensions.has(ext);
}

/**
 * Check collection-relative path eligibility without touching the filesystem.
 * This intentionally remains usable for deleted paths so incremental sync can
 * mark previously indexed documents inactive.
 */
export function matchesWalkPath(
  relPath: string,
  config: PathEligibilityConfig
): boolean {
  return matchesCompiledWalkPath(relPath, compileWalkMatcher(config));
}

async function runBounded<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);
  const runners = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      await worker(items[current]!);
    }
  });
  await Promise.all(runners);
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

  /**
   * Bounded async readdir traversal for `any` mode: prunes excluded subtrees
   * before descending, avoids redundant per-file `realpath()` for regular
   * files inside canonical `rootReal`, and runs `stat()` with bounded
   * concurrency. Symlinks continue through `safeRelPath` containment checks.
   */
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
    } catch (error) {
      // An unmounted drive or offline sync folder proves nothing about its
      // files, so the root is an unproven prefix, never an empty listing.
      skipped.push({
        absPath: rootAbs,
        relPath: "",
        reason: "SOURCE_AVAILABILITY_UNKNOWN",
        unprovenPrefix: true,
        message: `Collection root could not be resolved (${error instanceof Error ? error.message : String(error)}); indexed documents were kept`,
      });
      return { entries, skipped };
    }

    const matcher = compileWalkMatcher(config);
    const patternGlobs = patterns.map((pattern) => new Bun.Glob(pattern));
    const allowDotEntries = patterns.some((pattern) =>
      EXPLICIT_DOT_PATTERN.test(pattern)
    );

    const candidates: Array<{ absPath: string; relPath: string }> = [];
    const seenAbsPaths = new Set<string>();
    const symlinksToCheck: Array<{ absPath: string }> = [];
    let currentLevel: Array<{ absPath: string; relPath: string }> = [
      { absPath: rootReal, relPath: "" },
    ];

    while (currentLevel.length > 0) {
      const nextLevel: Array<{ absPath: string; relPath: string }> = [];
      await runBounded(currentLevel, READDIR_CONCURRENCY, async (dir) => {
        let dirents;
        try {
          dirents = await readdir(dir.absPath, { withFileTypes: true });
        } catch (error) {
          if (dir.relPath === "") {
            throw error;
          }
          return;
        }
        for (const dirent of dirents) {
          const name = dirent.name;
          if (name === "" || name === "." || name === "..") continue;
          if (name.includes("\0")) continue;
          // Preserve Bun.Glob.scan({ dot: false }) behavior unless the pattern
          // explicitly targets dot segments.
          if (!allowDotEntries && name.startsWith(".")) continue;

          const childAbs = join(dir.absPath, name);
          const childRel =
            dir.relPath === "" ? name : `${dir.relPath}/${toPosixPath(name)}`;

          if (dirent.isSymbolicLink()) {
            // Never descend through directory symlinks; validate leaf symlinks
            // via safeRelPath below.
            symlinksToCheck.push({ absPath: childAbs });
            continue;
          }

          if (dirent.isDirectory()) {
            if (isRecordVirtualPath(childRel)) continue;
            if (matchesCompiledSubtreeExclusion(childRel, matcher.exclusions)) {
              skipped.push({
                absPath: childAbs,
                relPath: childRel,
                reason: "EXCLUDED",
              });
              continue;
            }
            nextLevel.push({ absPath: childAbs, relPath: childRel });
            continue;
          }

          if (!dirent.isFile()) continue;

          // Pattern gate matches Bun.Glob.scan semantics first.
          if (!patternGlobs.some((glob) => glob.match(childRel))) continue;

          // Regular file under canonical rootReal with no symlink ancestors:
          // childAbs is already canonical and contained within rootReal.
          if (seenAbsPaths.has(childAbs)) continue;
          seenAbsPaths.add(childAbs);

          if (!matchesCompiledWalkPath(childRel, matcher)) {
            skipped.push({
              absPath: childAbs,
              relPath: childRel,
              reason: "EXCLUDED",
            });
            continue;
          }
          candidates.push({ absPath: childAbs, relPath: childRel });
        }
      });
      currentLevel = nextLevel;
    }

    // Resolve and containment-check symlinks (matching Bun.Glob followSymlinks:false
    // + safeRelPath semantics: escaping/broken/directory symlinks are skipped).
    if (symlinksToCheck.length > 0) {
      await runBounded(
        symlinksToCheck,
        STAT_CONCURRENCY,
        async ({ absPath }) => {
          const safePath = await safeRelPath(rootReal, absPath);
          if (safePath === null) return;
          if (!patternGlobs.some((glob) => glob.match(safePath.relPath)))
            return;
          if (seenAbsPaths.has(safePath.absPath)) return;
          seenAbsPaths.add(safePath.absPath);
          if (!matchesCompiledWalkPath(safePath.relPath, matcher)) {
            skipped.push({
              absPath: safePath.absPath,
              relPath: safePath.relPath,
              reason: "EXCLUDED",
            });
            return;
          }
          candidates.push(safePath);
        }
      );
    }

    // Bounded concurrent stat() across matched candidates.
    await runBounded(candidates, STAT_CONCURRENCY, async (candidate) => {
      const file = Bun.file(candidate.absPath);
      let stat: {
        size: number;
        mtime: Date;
        ctime?: Date;
        birthtime?: Date;
        isFile?: () => boolean;
      };
      try {
        stat = await file.stat();
      } catch {
        return;
      }
      if (typeof stat.isFile === "function" && !stat.isFile()) {
        return;
      }
      if (stat.size > config.maxBytes) {
        skipped.push({
          absPath: candidate.absPath,
          relPath: candidate.relPath,
          reason: "TOO_LARGE",
          size: stat.size,
        });
        return;
      }
      entries.push({
        absPath: candidate.absPath,
        relPath: candidate.relPath,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        ctime: (stat.birthtime ?? stat.ctime ?? stat.mtime).toISOString(),
      });
    });

    // Sort entries by relPath for deterministic output
    entries.sort((a, b) => a.relPath.localeCompare(b.relPath));
    skipped.sort((a, b) => a.relPath.localeCompare(b.relPath));

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

    const matcher = compileWalkMatcher(config);
    const regularCandidates: Array<{ absPath: string; relPath: string }> = [];
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
          if (!matchesCompiledWalkPath(childRel, matcher)) {
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
          if (matchesCompiledSubtreeExclusion(childRel, matcher.exclusions)) {
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

        // Regular file inside canonical rootReal with no symlink ancestors:
        // childAbs is already canonical and contained, skipping per-file realpath().
        if (!matchesCompiledWalkPath(childRel, matcher)) {
          skipped.push({
            absPath: childAbs,
            relPath: childRel,
            reason: "EXCLUDED",
          });
          continue;
        }
        regularCandidates.push({ absPath: childAbs, relPath: childRel });
      }
    }

    await runBounded(regularCandidates, STAT_CONCURRENCY, async (candidate) => {
      const file = Bun.file(candidate.absPath);
      let fileStat: {
        size: number;
        mtime: Date;
        ctime?: Date;
        birthtime?: Date;
      };
      try {
        fileStat = await file.stat();
      } catch {
        return;
      }

      if (fileStat.size > config.maxBytes) {
        skipped.push({
          absPath: candidate.absPath,
          relPath: candidate.relPath,
          reason: "TOO_LARGE",
          size: fileStat.size,
        });
        return;
      }

      entries.push({
        absPath: candidate.absPath,
        relPath: candidate.relPath,
        size: fileStat.size,
        mtime: fileStat.mtime.toISOString(),
        ctime: (
          fileStat.birthtime ??
          fileStat.ctime ??
          fileStat.mtime
        ).toISOString(),
      });
    });

    entries.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return { entries, skipped };
  }
}

/**
 * Default walker instance.
 */
export const defaultWalker = new FileWalker();
