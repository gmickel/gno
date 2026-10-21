/**
 * Validate caller-supplied paths for a path-level reindex.
 *
 * @module src/core/reindex-paths
 */

// node:fs/promises realpath, lstat/stat (symlinks, directories) and node:path
// have no Bun equivalent.
import { lstat, readlink, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { Collection } from "../config/types";

import { collectionToWalkConfig } from "../ingestion/types";
import { matchesWalkPath } from "../ingestion/walker";
import { MCP_ERRORS } from "./errors";

const escapes = (rel: string): boolean =>
  rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);

const toPosix = (rel: string): string => rel.split(sep).join("/");

const missing = (error: unknown): boolean =>
  error !== null &&
  typeof error === "object" &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR");

const MAX_SYMLINK_HOPS = 32;

/**
 * Most paths one request may list, and most a queued job keeps after merging.
 * Past it, reindexing the whole collection is the better call.
 */
export const MAX_REINDEX_PATHS = 256;

/**
 * Realpath of `path`, or of its nearest existing ancestor below `root`. A
 * dangling symlink on the way resolves to where it points, so a missing file
 * cannot leave the root through a link whose target does not exist.
 */
async function nearestRealpath(
  path: string,
  root: string,
  hops = 0
): Promise<string | null> {
  let current = path;
  for (;;) {
    try {
      return await realpath(current);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const isLink = await lstat(current).then(
      (stats) => stats.isSymbolicLink(),
      () => false
    );
    if (isLink) {
      const target = resolve(dirname(current), await readlink(current));
      if (hops >= MAX_SYMLINK_HOPS) return target;
      return (await nearestRealpath(target, root, hops + 1)) ?? target;
    }
    const parent = dirname(current);
    if (parent === current || relative(root, parent) === "") return null;
    current = parent;
  }
}

/**
 * Resolve paths (relative to the collection root, or absolute inside it) to
 * deduplicated collection-relative POSIX paths. A path that no longer exists
 * is kept so the sync can mark it inactive. Throws `INVALID_INPUT: ...` for an
 * empty list or more than `MAX_REINDEX_PATHS` paths, and `INVALID_PATH: ...`
 * for a directory or a path outside the root, including one that leaves it
 * through a symlink.
 */
export async function resolveReindexPaths(
  collection: Collection,
  paths: readonly unknown[]
): Promise<string[]> {
  if (paths.length === 0) {
    throw new Error(
      `${MCP_ERRORS.INVALID_INPUT.code}: paths must list at least one path`
    );
  }
  if (paths.length > MAX_REINDEX_PATHS) {
    throw new Error(
      `${MCP_ERRORS.INVALID_INPUT.code}: paths lists ${paths.length} paths (at most ${MAX_REINDEX_PATHS}); reindex the whole collection instead`
    );
  }
  const root = resolve(collection.path);
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    realRoot = root;
  }
  const resolved = new Set<string>();
  for (const path of paths) {
    if (typeof path !== "string" || path.trim() === "") {
      throw new Error(
        `${MCP_ERRORS.INVALID_INPUT.code}: paths must be non-empty strings`
      );
    }
    const absolute = resolve(root, path);
    const rel = relative(root, absolute);
    if (escapes(rel)) {
      throw new Error(
        `${MCP_ERRORS.INVALID_PATH.code}: ${path} is outside collection ${collection.name}`
      );
    }
    // A missing file is checked through its nearest existing folder, so a
    // deletion path cannot leave the root through a symlinked parent.
    const real = await nearestRealpath(absolute, root);
    if (
      real !== null &&
      escapes(relative(realRoot, real)) &&
      real !== realRoot
    ) {
      throw new Error(
        `${MCP_ERRORS.INVALID_PATH.code}: ${path} resolves outside collection ${collection.name}`
      );
    }
    const isDirectory = await stat(absolute).then(
      (stats) => stats.isDirectory(),
      () => false
    );
    if (isDirectory) {
      throw new Error(
        `${MCP_ERRORS.INVALID_PATH.code}: ${path} is a directory; list the files in it, or reindex the whole collection`
      );
    }
    // A listed path obeys the collection's own pattern, include and exclude
    // rules: an excluded file must not become searchable by naming it.
    if (!matchesWalkPath(toPosix(rel), collectionToWalkConfig(collection, 0))) {
      throw new Error(
        `${MCP_ERRORS.INVALID_PATH.code}: ${path} is not part of collection ${collection.name} (its pattern, include or exclude rules leave it out)`
      );
    }
    resolved.add(toPosix(rel));
  }
  return [...resolved];
}

/**
 * Resolve an optional path list for a reindex request. Paths need a single
 * collection and apply to a plain sync: git pull and update commands act on
 * the whole collection, so they cannot be combined with paths.
 */
export async function resolveReindexScope(
  collection: Collection | null,
  paths: readonly unknown[] | undefined,
  options: { gitPull?: boolean; runUpdateCmd?: boolean } = {}
): Promise<string[] | null> {
  if (paths === undefined) return null;
  if (!collection) {
    throw new Error(
      `${MCP_ERRORS.INVALID_INPUT.code}: paths require a collection`
    );
  }
  if (options.gitPull || options.runUpdateCmd) {
    throw new Error(
      `${MCP_ERRORS.INVALID_INPUT.code}: paths cannot be combined with gitPull or an update command`
    );
  }
  return resolveReindexPaths(collection, paths);
}
