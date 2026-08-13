/**
 * No-follow disk enumeration for watcher fallback classification.
 *
 * @module src/serve/watch-reconciliation-fallback-disk
 */

// node:fs/promises — structure ops for path-backed no-follow Windows/unsupported
import { lstat, readdir } from "node:fs/promises";

import type { Collection } from "../config/types";

import { matchesCollectionExclusion } from "../core/path-rules";
import { collectionToWalkConfig, matchesWalkPath } from "../ingestion";
import {
  createPathBackedWatcherFs,
  defaultFs,
  openDirByRel,
} from "./watch-snapshot-scan";
import {
  isMissingFsError,
  joinWatcherRelPath,
  parentWatcherDir,
  type WatcherSnapshotFs,
  type WatcherSnapshotStat,
} from "./watch-snapshot-types";

export interface FallbackBudget {
  readonly limit: number;
  visitedDirs: number;
  candidates: number;
  removals: number;
  dirtyDirs: number;
  storeRows: number;
}

export function budgetExceeded(b: FallbackBudget): boolean {
  return (
    b.visitedDirs > b.limit ||
    b.candidates > b.limit ||
    b.removals > b.limit ||
    b.dirtyDirs > b.limit ||
    b.storeRows > b.limit
  );
}

/** Path-backed no-follow FS for platforms without anchored handles (Windows). */
export function createNoFollowPathFs(): WatcherSnapshotFs {
  return createPathBackedWatcherFs({
    readdir: async (absPath) => readdir(absPath),
    lstat: async (absPath) => {
      // Presence/kind only for fallback disk walks; ns fields optional.
      const info = await lstat(absPath);
      const withNs = info as typeof info & {
        mtimeNs?: bigint | number;
        ctimeNs?: bigint | number;
      };
      return {
        isFile: () => info.isFile(),
        isDirectory: () => info.isDirectory(),
        isSymbolicLink: () => info.isSymbolicLink(),
        dev: info.dev,
        ino: info.ino,
        size: info.size,
        mtimeNs: withNs.mtimeNs,
        ctimeNs: withNs.ctimeNs,
      } satisfies WatcherSnapshotStat;
    },
  });
}

export function fallbackFs(): WatcherSnapshotFs {
  return defaultFs.supportsAnchoredHandles ? defaultFs : createNoFollowPathFs();
}

export type DiskListResult =
  | { status: "ok"; paths: string[]; rootDirNames: string[] }
  | { status: "overflow" }
  | { status: "error"; cause: unknown };

/**
 * Bounded no-follow BFS under `dirRel`. Stops enumeration at remaining+1 names.
 * Never descends through symlinks.
 */
export async function listEligibleDiskSources(
  rootAbs: string,
  dirRel: string,
  collection: Collection,
  fs: WatcherSnapshotFs,
  budget: FallbackBudget
): Promise<DiskListResult> {
  const walkConfig = collectionToWalkConfig(collection, 0);
  const paths: string[] = [];
  const rootDirNames: string[] = [];
  const queue: string[] = [dirRel];
  let head = 0;

  while (head < queue.length) {
    const current = queue[head] as string;
    head += 1;
    budget.visitedDirs += 1;
    if (budgetExceeded(budget)) {
      return { status: "overflow" };
    }

    const remaining = Math.max(0, budget.limit - budget.visitedDirs + 1);
    const opened = await openDirByRel(rootAbs, current, fs);
    if (opened.status === "missing") {
      continue;
    }
    if (opened.status !== "ok") {
      return {
        status: "error",
        cause:
          opened.status === "scan_failed"
            ? opened.cause
            : new Error(`Disk scan failed under ${current || "."}`),
      };
    }

    let listed;
    try {
      listed = await fs.readDir(opened.handle, remaining);
    } catch (cause) {
      await fs.closeDir(opened.handle);
      if (isMissingFsError(cause)) {
        continue;
      }
      return { status: "error", cause };
    }

    if (listed.status === "overflow") {
      await fs.closeDir(opened.handle);
      return { status: "overflow" };
    }

    const names = [...listed.names].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    for (const name of names) {
      if (name === "" || name === "." || name === "..") {
        continue;
      }
      if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
        await fs.closeDir(opened.handle);
        return {
          status: "error",
          cause: new Error(`Invalid directory entry name: ${name}`),
        };
      }

      let stat: WatcherSnapshotStat;
      try {
        stat = await fs.lstatChild(opened.handle, name);
      } catch (cause) {
        await fs.closeDir(opened.handle);
        if (isMissingFsError(cause)) {
          return { status: "error", cause };
        }
        return { status: "error", cause };
      }

      const childRel = joinWatcherRelPath(current, name);
      if (matchesCollectionExclusion(childRel, walkConfig.exclude)) {
        continue;
      }

      // Never follow symlinks; eligible link paths stay leaf candidates.
      if (stat.isSymbolicLink()) {
        if (matchesWalkPath(childRel, walkConfig)) {
          paths.push(childRel);
          if (paths.length > budget.limit) {
            await fs.closeDir(opened.handle);
            return { status: "overflow" };
          }
        }
        continue;
      }

      if (stat.isDirectory()) {
        if (current === "") {
          rootDirNames.push(name);
        }
        queue.push(childRel);
        continue;
      }

      if (!stat.isFile() || !matchesWalkPath(childRel, walkConfig)) {
        continue;
      }
      paths.push(childRel);
      if (paths.length > budget.limit) {
        await fs.closeDir(opened.handle);
        return { status: "overflow" };
      }
    }
    await fs.closeDir(opened.handle);
  }

  return { status: "ok", paths, rootDirNames };
}

export async function inspectNoFollowPresence(
  rootAbs: string,
  relPath: string,
  fs: WatcherSnapshotFs
): Promise<
  | { status: "present" }
  | { status: "missing" }
  | { status: "error"; cause: unknown }
> {
  const parent = parentWatcherDir(relPath);
  if (parent === null) {
    return { status: "missing" };
  }
  const base = parent === "" ? relPath : relPath.slice(parent.length + 1);
  if (base === "" || base.includes("/")) {
    return { status: "error", cause: new Error(`Invalid path: ${relPath}`) };
  }
  const opened = await openDirByRel(rootAbs, parent, fs);
  if (opened.status === "missing") {
    return { status: "missing" };
  }
  if (opened.status !== "ok") {
    return {
      status: "error",
      cause:
        opened.status === "scan_failed"
          ? opened.cause
          : new Error("Failed to open parent for presence check"),
    };
  }
  try {
    await fs.lstatChild(opened.handle, base);
    return { status: "present" };
  } catch (cause) {
    if (isMissingFsError(cause)) {
      return { status: "missing" };
    }
    return { status: "error", cause };
  } finally {
    await fs.closeDir(opened.handle);
  }
}
