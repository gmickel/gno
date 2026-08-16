/**
 * Identity-aware no-follow directory scanning and mutable snapshot maps.
 *
 * @module src/serve/watch-snapshot-scan
 */

import type {
  ScanFailure,
  SnapshotEntryFingerprint,
  SnapshotMapHooks,
  WatcherDirHandle,
  WatcherSnapshot,
  WatcherSnapshotClock,
  WatcherSnapshotFs,
  WatcherSnapshotStat,
} from "./watch-snapshot-types";

import { createDefaultWatcherFs } from "./watch-snapshot-handles";
import {
  fingerprintFromStat,
  isMissingFsError,
  isWatcherSourceKind,
  joinWatcherRelPath,
} from "./watch-snapshot-types";

export { createPathBackedWatcherFs } from "./watch-snapshot-handles";

export const defaultClock: WatcherSnapshotClock = {
  nowMs: () => performance.now(),
};

export const defaultFs: WatcherSnapshotFs = createDefaultWatcherFs();

/** Mutable hierarchical maps with incremental entry accounting. */
export interface MutableSnapshotMaps {
  directories: Map<string, Map<string, SnapshotEntryFingerprint>>;
  entryCount: number;
  unprovenSubtrees: Set<string>;
}

export function cloneDirectoryMaps(
  source: WatcherSnapshot
): MutableSnapshotMaps {
  const directories = new Map<string, Map<string, SnapshotEntryFingerprint>>();
  for (const [dir, entries] of source.directories) {
    directories.set(dir, new Map(entries));
  }
  return {
    directories,
    entryCount: source.entryCount,
    unprovenSubtrees: new Set(source.unprovenSubtrees ?? []),
  };
}

export function freezeSnapshot(state: MutableSnapshotMaps): WatcherSnapshot {
  const frozen = new Map<
    string,
    ReadonlyMap<string, SnapshotEntryFingerprint>
  >();
  for (const [dir, entries] of state.directories) {
    frozen.set(dir, entries);
  }
  return {
    directories: frozen,
    entryCount: state.entryCount,
    unprovenSubtrees: new Set(state.unprovenSubtrees),
  };
}

/** Replace one directory's entry map; O(1) entryCount update. */
export function setDirectoryEntries(
  state: MutableSnapshotMaps,
  dirRel: string,
  entries: Map<string, SnapshotEntryFingerprint>
): void {
  const previous = state.directories.get(dirRel);
  const previousSize = previous?.size ?? 0;
  state.directories.set(dirRel, entries);
  state.entryCount += entries.size - previousSize;
}

/**
 * Hierarchical O(subtree-size) removal using stored child relationships.
 * Single pass: collect non-directory paths and delete maps — no full-map
 * prefix scan and no separate collect-then-remove phases.
 */
export function removeSubtreeFromMaps(
  state: MutableSnapshotMaps,
  dirRel: string,
  hooks?: SnapshotMapHooks
): string[] {
  const removedCandidates: string[] = [];
  const stack: string[] = [dirRel];

  while (stack.length > 0) {
    const dir = stack.pop() as string;
    hooks?.onDirectoryMapVisit?.();
    const entries = state.directories.get(dir);
    if (!entries) {
      continue;
    }
    for (const [name, fingerprint] of entries) {
      const childRel = joinWatcherRelPath(dir, name);
      if (fingerprint.kind === "directory") {
        stack.push(childRel);
      } else if (isWatcherSourceKind(fingerprint.kind)) {
        // Only file/symlink sources are indexable; ignore FIFO/socket/device.
        removedCandidates.push(childRel);
      }
    }
    state.entryCount -= entries.size;
    state.directories.delete(dir);
  }

  return removedCandidates;
}

/**
 * Hierarchical collect of file/symlink source paths under a stored directory.
 * O(subtree-size) via child relationships — not a full-map prefix scan.
 * Special `other` entries are never collected (never indexed as sources).
 */
export function collectSnapshotFilesUnder(
  directories: ReadonlyMap<
    string,
    ReadonlyMap<string, SnapshotEntryFingerprint>
  >,
  dirRel: string,
  hooks?: SnapshotMapHooks
): string[] {
  const out: string[] = [];
  const stack: string[] = [dirRel];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    hooks?.onDirectoryMapVisit?.();
    const entries = directories.get(dir);
    if (!entries) {
      continue;
    }
    for (const [name, fingerprint] of entries) {
      const childRel = joinWatcherRelPath(dir, name);
      if (fingerprint.kind === "directory") {
        stack.push(childRel);
      } else if (isWatcherSourceKind(fingerprint.kind)) {
        out.push(childRel);
      }
    }
  }
  return out;
}

/**
 * Open a collection-relative directory by walking components from the root
 * handle. Never opens a full joined path that could traverse intermediate
 * symlinks.
 */
export async function openDirByRel(
  rootAbs: string,
  dirRel: string,
  fs: WatcherSnapshotFs
): Promise<
  | { status: "ok"; handle: WatcherDirHandle }
  | { status: "missing" }
  | ScanFailure
> {
  if (!fs.supportsAnchoredHandles) {
    return {
      status: "scan_failed",
      cause: new Error(
        "Anchored no-follow directory handles unavailable; refusing path-based scan"
      ),
    };
  }

  let handle: WatcherDirHandle;
  try {
    handle = await fs.openDir(rootAbs);
  } catch (cause) {
    if (isMissingFsError(cause)) {
      return { status: "missing" };
    }
    return { status: "scan_failed", cause };
  }

  if (dirRel === "") {
    return { status: "ok", handle };
  }

  const segments = dirRel.split("/");
  for (const segment of segments) {
    let child: WatcherDirHandle;
    try {
      // Reject non-directory / symlink components by requiring openChildDir.
      child = await fs.openChildDir(handle, segment);
    } catch (cause) {
      await fs.closeDir(handle);
      if (isMissingFsError(cause)) {
        return { status: "missing" };
      }
      return { status: "scan_failed", cause };
    }
    await fs.closeDir(handle);
    handle = child;
  }
  return { status: "ok", handle };
}

/**
 * Enumerate direct children via an anchored directory handle.
 * Child metadata is resolved relative to the handle — a path swap after open
 * cannot redirect lstat outside the pinned directory.
 *
 * `maxEntries` is the remaining entry budget for this directory map. Enumeration
 * and stats stop after observing `maxEntries + 1` children so overflow is proven
 * without materializing an unbounded name/stat map.
 */
export async function readDirectChildren(
  rootAbs: string,
  dirRel: string,
  fs: WatcherSnapshotFs,
  maxEntries: number
): Promise<
  | { status: "present"; entries: Map<string, SnapshotEntryFingerprint> }
  | { status: "missing" }
  | ScanFailure
> {
  if (!fs.supportsAnchoredHandles) {
    return {
      status: "scan_failed",
      cause: new Error(
        "Anchored no-follow directory handles unavailable; refusing path-based scan"
      ),
    };
  }
  if (!Number.isInteger(maxEntries) || maxEntries < 0) {
    return {
      status: "scan_failed",
      cause: new Error("maxEntries must be a non-negative integer"),
    };
  }

  const opened = await openDirByRel(rootAbs, dirRel, fs);
  if (opened.status !== "ok") {
    return opened;
  }
  const { handle } = opened;

  try {
    let listed;
    try {
      // Cap names at remaining budget; maxEntries+1th name → overflow.
      listed = await fs.readDir(handle, maxEntries);
    } catch (cause) {
      if (isMissingFsError(cause)) {
        return { status: "missing" };
      }
      return { status: "scan_failed", cause };
    }
    if (listed.status === "overflow") {
      return { status: "overflow" };
    }

    const names = listed.names;
    const entries = new Map<string, SnapshotEntryFingerprint>();
    // Stable order keeps overflow selection deterministic across platforms.
    names.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    for (const name of names) {
      if (name === "" || name === "." || name === "..") {
        continue;
      }
      if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
        return {
          status: "scan_failed",
          cause: new Error(`Invalid directory entry name: ${name}`),
        };
      }
      // Defense in depth: never stat/map more than the remaining budget.
      if (entries.size >= maxEntries) {
        return { status: "overflow" };
      }
      let stat: WatcherSnapshotStat;
      try {
        stat = await fs.lstatChild(handle, name);
      } catch (cause) {
        // Observed-then-missing (ENOENT/ENOTDIR after readdir listed the name)
        // must fail closed: silently skipping would accept a partial directory
        // image and can prove false removals against the previous snapshot.
        return { status: "scan_failed", cause };
      }
      const fingerprinted = fingerprintFromStat(stat);
      if (!fingerprinted.ok) {
        return { status: "unreliable_metadata" };
      }
      entries.set(name, fingerprinted.fingerprint);
    }
    return { status: "present", entries };
  } finally {
    await fs.closeDir(handle);
  }
}
