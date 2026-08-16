/**
 * No-follow disk enumeration for watcher fallback classification.
 * Platforms without genuine anchored handles fail closed — no path-based TOCTOU
 * fallback in production (createPathBackedWatcherFs is test-only).
 *
 * @module src/serve/watch-reconciliation-fallback-disk
 */

// node:path — Bun has no path join helper.
import { join } from "node:path";

import type { Collection } from "../config/types";
import type { DirectoryAvailabilityPort } from "../ingestion/source-availability";

import {
  matchesCollectionExclusion,
  matchesCollectionSubtreeExclusion,
} from "../core/path-rules";
import { collectionToWalkConfig, matchesWalkPath } from "../ingestion";
import { findUnprovenAvailabilityPrefix } from "../ingestion/source-availability";
import { defaultFs, openDirByRel } from "./watch-snapshot-scan";
import {
  isMissingFsError,
  joinWatcherRelPath,
  parentWatcherDir,
  type WatcherSnapshotFs,
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

/**
 * Production fallback FS: anchored handles only. Unsupported platforms surface
 * scan_failed/ENOTSUP via openDirByRel — never claim path-based safety.
 */
export function fallbackFs(): WatcherSnapshotFs {
  return defaultFs;
}

export type DiskListResult =
  | {
      status: "ok";
      paths: string[];
      rootDirNames: string[];
      unprovenPrefixes: string[];
    }
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
  budget: FallbackBudget,
  directoryAvailability?: DirectoryAvailabilityPort
): Promise<DiskListResult> {
  const walkConfig = collectionToWalkConfig(collection, 0);
  const paths: string[] = [];
  const rootDirNames: string[] = [];
  const unprovenPrefixes: string[] = [];
  const queue: string[] = [dirRel];
  let head = 0;

  while (head < queue.length) {
    const current = queue[head] as string;
    head += 1;
    if (
      current !== "" &&
      matchesCollectionSubtreeExclusion(current, walkConfig.exclude)
    ) {
      continue;
    }
    budget.visitedDirs += 1;
    if (budgetExceeded(budget)) {
      return { status: "overflow" };
    }

    const remaining = Math.max(0, budget.limit - budget.visitedDirs + 1);
    if (directoryAvailability?.mode === "local") {
      if (!fs.readDirectChildrenSync) {
        unprovenPrefixes.push(current);
        continue;
      }
      const absPath = current === "" ? rootAbs : join(rootAbs, current);
      const guarded = directoryAvailability.readDirectory(absPath, () =>
        fs.readDirectChildrenSync!(rootAbs, current, remaining)
      );
      if (guarded.kind !== "available") {
        unprovenPrefixes.push(current);
        continue;
      }
      const listed = guarded.value;
      if (listed.status === "missing") {
        continue;
      }
      if (listed.status === "overflow") {
        return { status: "overflow" };
      }
      if (listed.status !== "present") {
        return {
          status: "error",
          cause:
            listed.status === "scan_failed"
              ? listed.cause
              : new Error(`Disk scan failed under ${current || "."}`),
        };
      }
      for (const [name, fingerprint] of listed.entries) {
        const childRel = joinWatcherRelPath(current, name);
        if (fingerprint.kind === "directory") {
          if (matchesCollectionSubtreeExclusion(childRel, walkConfig.exclude)) {
            continue;
          }
          if (current === "") {
            rootDirNames.push(name);
          }
          queue.push(childRel);
        } else if (matchesCollectionExclusion(childRel, walkConfig.exclude)) {
          continue;
        } else if (fingerprint.kind === "symlink") {
          if (matchesWalkPath(childRel, walkConfig)) {
            paths.push(childRel);
          }
        } else if (
          fingerprint.kind === "file" &&
          matchesWalkPath(childRel, walkConfig)
        ) {
          paths.push(childRel);
        }
        if (paths.length > budget.limit) {
          return { status: "overflow" };
        }
      }
      continue;
    }

    const scanCurrent = async (): Promise<
      | { status: "ok" }
      | { status: "overflow" }
      | { status: "error"; cause: unknown }
    > => {
      const opened = await openDirByRel(rootAbs, current, fs);
      if (opened.status === "missing") {
        return { status: "ok" };
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

      try {
        const listed = await fs.readDir(opened.handle, remaining);
        if (listed.status === "overflow") {
          return { status: "overflow" };
        }
        const names = [...listed.names].sort((a, b) =>
          a < b ? -1 : a > b ? 1 : 0
        );
        for (const name of names) {
          if (name === "" || name === "." || name === "..") {
            continue;
          }
          if (
            name.includes("/") ||
            name.includes("\\") ||
            name.includes("\0")
          ) {
            return {
              status: "error",
              cause: new Error(`Invalid directory entry name: ${name}`),
            };
          }

          const stat = await fs.lstatChild(opened.handle, name);
          const childRel = joinWatcherRelPath(current, name);
          if (stat.isDirectory()) {
            if (
              matchesCollectionSubtreeExclusion(childRel, walkConfig.exclude)
            ) {
              continue;
            }
            if (current === "") {
              rootDirNames.push(name);
            }
            queue.push(childRel);
            continue;
          }
          if (matchesCollectionExclusion(childRel, walkConfig.exclude)) {
            continue;
          }
          if (stat.isSymbolicLink()) {
            if (matchesWalkPath(childRel, walkConfig)) {
              paths.push(childRel);
              if (paths.length > budget.limit) {
                return { status: "overflow" };
              }
            }
            continue;
          }
          if (!stat.isFile() || !matchesWalkPath(childRel, walkConfig)) {
            continue;
          }
          paths.push(childRel);
          if (paths.length > budget.limit) {
            return { status: "overflow" };
          }
        }
        return { status: "ok" };
      } catch (cause) {
        return { status: "error", cause };
      } finally {
        await fs.closeDir(opened.handle);
      }
    };

    const scanned = await scanCurrent();
    if (scanned.status !== "ok") {
      return scanned;
    }
  }

  return { status: "ok", paths, rootDirNames, unprovenPrefixes };
}

export async function inspectNoFollowPresence(
  rootAbs: string,
  relPath: string,
  fs: WatcherSnapshotFs,
  directoryAvailability?: DirectoryAvailabilityPort
): Promise<
  | { status: "present"; indexable: boolean }
  | { status: "missing" }
  | { status: "error"; cause: unknown }
> {
  if (directoryAvailability?.mode === "local") {
    const unproven = await findUnprovenAvailabilityPrefix(
      rootAbs,
      relPath,
      directoryAvailability
    );
    if (unproven) {
      return {
        status: "error",
        cause: new Error(
          `Source absence is unproven under ${unproven.relPath || "."}: ${unproven.code}`
        ),
      };
    }
  }
  const parent = parentWatcherDir(relPath);
  if (parent === null) {
    return { status: "missing" };
  }
  const base = parent === "" ? relPath : relPath.slice(parent.length + 1);
  if (base === "" || base.includes("/")) {
    return { status: "error", cause: new Error(`Invalid path: ${relPath}`) };
  }
  const inspectParent = async (): Promise<
    | { status: "present"; indexable: boolean }
    | { status: "missing" }
    | { status: "error"; cause: unknown }
  > => {
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
      const stat = await fs.lstatChild(opened.handle, base);
      // Only regular files / symlinks are indexable sources. Directory, FIFO,
      // device, and other specials prove the prior file source is gone.
      const indexable = stat.isFile() || stat.isSymbolicLink();
      return { status: "present", indexable };
    } catch (cause) {
      if (isMissingFsError(cause)) {
        return { status: "missing" };
      }
      return { status: "error", cause };
    } finally {
      await fs.closeDir(opened.handle);
    }
  };

  if (directoryAvailability?.mode === "local") {
    if (!fs.lstatChildByRelSync) {
      return {
        status: "error",
        cause: new Error(
          "Synchronous anchored child metadata is unavailable in local mode"
        ),
      };
    }
    const parentAbs = parent === "" ? rootAbs : join(rootAbs, parent);
    const guarded = directoryAvailability.readDirectory(parentAbs, () => {
      try {
        return {
          status: "present" as const,
          stat: fs.lstatChildByRelSync!(rootAbs, parent, base),
        };
      } catch (cause) {
        if (isMissingFsError(cause)) {
          return { status: "missing" as const };
        }
        throw cause;
      }
    });
    if (guarded.kind !== "available") {
      return {
        status: "error",
        cause: new Error(
          `Source absence is unproven under ${parent || "."}: ${guarded.code}`
        ),
      };
    }
    if (guarded.value.status === "missing") {
      return { status: "missing" };
    }
    return {
      status: "present",
      indexable:
        guarded.value.stat.isFile() || guarded.value.stat.isSymbolicLink(),
    };
  }
  return inspectParent();
}
