/**
 * Untrusted watcher hint → dirty directory resolution + reconcile orchestration.
 *
 * Resolves path components one at a time from an anchored root handle so
 * intermediate symlinks are never descended and outside children are never
 * lstat'd through a link-out prefix.
 *
 * @module src/serve/watch-snapshot-resolve
 */

// node:path — Bun has no path utilities
import { resolve, sep } from "node:path";

import type {
  WatcherDirHandle,
  WatcherSnapshot,
  WatcherSnapshotDiffResult,
  WatcherSnapshotOptions,
} from "./watch-snapshot-types";

import { diffWatcherSnapshot } from "./watch-snapshot-ops";
import { defaultClock, defaultFs } from "./watch-snapshot-scan";
import {
  isMissingFsError,
  joinWatcherRelPath,
  normalizeWatcherRelPath,
  parentWatcherDir,
} from "./watch-snapshot-types";

/**
 * Resolve an untrusted hint to the dirty directory that should be diffed.
 * Missing paths climb to the nearest surviving in-root ancestor.
 *
 * A missing collection root is not a deletion proof: returns scan_failed
 * fallback so callers do not emit removal candidates or advance snapshots.
 *
 * Symlink (or non-directory) components stop descent: the containing directory
 * is returned so the parent listing observes the link/file without following it.
 */
export async function resolveWatcherDirtyDirectory(
  rootAbs: string,
  hint: string,
  options: WatcherSnapshotOptions = {}
): Promise<
  | { status: "ok"; directory: string }
  | { status: "invalid" }
  | { status: "fallback"; reason: "scan_failed"; cause?: unknown }
> {
  const normalized = normalizeWatcherRelPath(hint);
  if (normalized === null) {
    return { status: "invalid" };
  }

  // Reject absolute-after-join escapes: only allow paths under rootAbs lexically.
  const rootResolved = resolve(rootAbs);
  if (normalized !== "") {
    const absCandidate = resolve(rootResolved, ...normalized.split("/"));
    const rel = absCandidate.startsWith(rootResolved + sep)
      ? absCandidate.slice(rootResolved.length + sep.length)
      : absCandidate === rootResolved
        ? ""
        : null;
    if (rel === null) {
      return { status: "invalid" };
    }
  }

  const fs = options.fs ?? defaultFs;
  if (!fs.supportsAnchoredHandles) {
    return {
      status: "fallback",
      reason: "scan_failed",
      cause: new Error(
        "Anchored no-follow directory handles unavailable; refusing path-based hint resolution"
      ),
    };
  }

  let rootHandle: WatcherDirHandle;
  try {
    rootHandle = await fs.openDir(rootResolved);
  } catch (cause) {
    if (isMissingFsError(cause)) {
      return {
        status: "fallback",
        reason: "scan_failed",
        cause: new Error("Collection root is missing"),
      };
    }
    return { status: "fallback", reason: "scan_failed", cause };
  }

  const opened: WatcherDirHandle[] = [rootHandle];
  const closeAll = async (): Promise<void> => {
    for (let i = opened.length - 1; i >= 0; i -= 1) {
      const handle = opened[i];
      if (handle) {
        await fs.closeDir(handle);
      }
    }
    opened.length = 0;
  };

  try {
    if (normalized === "") {
      return { status: "ok", directory: "" };
    }

    const segments = normalized.split("/");
    let parentHandle = rootHandle;
    let parentRel = "";

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index] as string;
      let stat;
      try {
        stat = await fs.lstatChild(parentHandle, segment);
      } catch (cause) {
        if (isMissingFsError(cause)) {
          // Missing component: dirty directory is the nearest surviving ancestor.
          return { status: "ok", directory: parentRel };
        }
        return {
          status: "fallback",
          reason: "scan_failed",
          cause: new Error(`Failed to inspect hint segment: ${segment}`),
        };
      }

      const childRel = joinWatcherRelPath(parentRel, segment);
      const isLast = index === segments.length - 1;

      // Never descend through symlink / file / other — parent listing is dirty.
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        return { status: "ok", directory: parentRel };
      }

      // Real directory.
      if (isLast) {
        return { status: "ok", directory: childRel };
      }

      try {
        const childHandle = await fs.openChildDir(parentHandle, segment);
        opened.push(childHandle);
        parentHandle = childHandle;
        parentRel = childRel;
      } catch (cause) {
        if (isMissingFsError(cause)) {
          return { status: "ok", directory: parentRel };
        }
        return { status: "fallback", reason: "scan_failed", cause };
      }
    }

    return { status: "ok", directory: parentRel };
  } finally {
    await closeAll();
  }
}

/** True when `dirRel` is a directory edge under its parent in `snapshot`. */
function directoryHasParentEdge(
  snapshot: WatcherSnapshot,
  dirRel: string
): boolean {
  if (dirRel === "") {
    return true;
  }
  const parent = parentWatcherDir(dirRel);
  if (parent === null) {
    return true;
  }
  const base = dirRel.slice(parent === "" ? 0 : parent.length + 1);
  return snapshot.directories.get(parent)?.get(base)?.kind === "directory";
}

/**
 * Choose the dirty directory for a resolved on-disk directory hint.
 * New-relative-to-snapshot directories climb to the nearest known container so
 * parent edges are recorded (no orphan maps).
 */
function dirtyDirectoryForResolvedHint(
  previous: WatcherSnapshot,
  dirRel: string
): string {
  if (dirRel === "" || directoryHasParentEdge(previous, dirRel)) {
    return dirRel;
  }
  let climb: string | null = parentWatcherDir(dirRel);
  while (climb !== null) {
    if (
      climb === "" ||
      directoryHasParentEdge(previous, climb) ||
      previous.directories.has(climb)
    ) {
      return climb;
    }
    climb = parentWatcherDir(climb);
  }
  return "";
}

/**
 * Resolve dirty directories from untrusted hints, then diff against `previous`.
 * Invalid hints are skipped; all-invalid yields an empty ok diff.
 * Scan/metadata failure never advances the snapshot.
 */
export async function reconcileWatcherHints(
  rootAbs: string,
  previous: WatcherSnapshot,
  hints: readonly string[],
  options: WatcherSnapshotOptions = {}
): Promise<WatcherSnapshotDiffResult> {
  const clock = options.clock ?? defaultClock;
  const started = clock.nowMs();
  const dirty = new Set<string>();

  for (const hint of hints) {
    const resolved = await resolveWatcherDirtyDirectory(rootAbs, hint, options);
    if (resolved.status === "invalid") {
      continue;
    }
    if (resolved.status === "fallback") {
      return {
        status: "fallback",
        reason: "scan_failed",
        discoveryMs: clock.nowMs() - started,
        cause: resolved.cause,
      };
    }
    dirty.add(dirtyDirectoryForResolvedHint(previous, resolved.directory));
  }

  if (dirty.size === 0) {
    return {
      status: "ok",
      candidates: [],
      removals: [],
      nextSnapshot: previous,
      discoveryMs: clock.nowMs() - started,
    };
  }

  return diffWatcherSnapshot(rootAbs, previous, [...dirty], options);
}
