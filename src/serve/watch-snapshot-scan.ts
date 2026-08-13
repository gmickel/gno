/**
 * Identity-aware no-follow directory scanning and mutable snapshot maps.
 *
 * @module src/serve/watch-snapshot-scan
 */

// node:fs/promises — Bun has no readdir/lstat with Dirent/bigint metadata
import {
  lstat as defaultLstat,
  readdir as defaultReaddir,
} from "node:fs/promises";
// node:path — Bun has no path utilities
import { join } from "node:path";

import type {
  ScanFailure,
  SnapshotEntryFingerprint,
  WatcherSnapshot,
  WatcherSnapshotClock,
  WatcherSnapshotFs,
  WatcherSnapshotStat,
} from "./watch-snapshot-types";

import {
  directoryIsUnder,
  fingerprintFromStat,
  isMissingFsError,
  joinWatcherRelPath,
  kindOf,
  toBigInt,
} from "./watch-snapshot-types";

export const defaultClock: WatcherSnapshotClock = {
  nowMs: () => performance.now(),
};

export const defaultFs: WatcherSnapshotFs = {
  readdir: async (absPath: string): Promise<string[]> =>
    defaultReaddir(absPath),
  lstat: async (absPath: string): Promise<WatcherSnapshotStat> => {
    const stat = await defaultLstat(absPath, { bigint: true });
    return {
      isFile: () => stat.isFile(),
      isDirectory: () => stat.isDirectory(),
      isSymbolicLink: () => stat.isSymbolicLink(),
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
    };
  },
};

/** Mutable hierarchical maps with incremental entry accounting. */
export interface MutableSnapshotMaps {
  directories: Map<string, Map<string, SnapshotEntryFingerprint>>;
  entryCount: number;
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
 * Remove a directory subtree from mutable maps.
 * Returns removal candidates (non-directory paths under the subtree).
 */
export function removeSubtreeFromMaps(
  state: MutableSnapshotMaps,
  dirRel: string
): string[] {
  const removedCandidates: string[] = [];
  const dirsToDelete: string[] = [];

  for (const [dir, entries] of state.directories) {
    if (!directoryIsUnder(dir, dirRel)) {
      continue;
    }
    for (const [name, fingerprint] of entries) {
      if (fingerprint.kind !== "directory") {
        removedCandidates.push(joinWatcherRelPath(dir, name));
      }
    }
    dirsToDelete.push(dir);
  }

  for (const dir of dirsToDelete) {
    const entries = state.directories.get(dir);
    if (entries) {
      state.entryCount -= entries.size;
      state.directories.delete(dir);
    }
  }
  return removedCandidates;
}

export function collectSnapshotFilesUnder(
  directories: ReadonlyMap<
    string,
    ReadonlyMap<string, SnapshotEntryFingerprint>
  >,
  dirRel: string
): string[] {
  const out: string[] = [];
  for (const [dir, entries] of directories) {
    if (!directoryIsUnder(dir, dirRel)) {
      continue;
    }
    for (const [name, fingerprint] of entries) {
      if (fingerprint.kind !== "directory") {
        out.push(joinWatcherRelPath(dir, name));
      }
    }
  }
  return out;
}

function isRealDirectory(stat: WatcherSnapshotStat): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink();
}

function identityOf(
  stat: WatcherSnapshotStat
): { device: bigint; inode: bigint } | null {
  const device = toBigInt(stat.dev);
  const inode = toBigInt(stat.ino);
  if (device === null || inode === null) {
    return null;
  }
  return { device, inode };
}

/**
 * Enumerate direct children of a real directory without following symlinks.
 *
 * Identity-aware: lstats the directory itself before and after readdir and
 * requires it remain a real directory with the same device/inode. On
 * symlink/kind/identity change, fails closed before any child lstat so a
 * TOCTOU swap to an outside symlink cannot cause traversal outside root.
 */
export async function readDirectChildren(
  rootAbs: string,
  dirRel: string,
  fs: WatcherSnapshotFs
): Promise<
  | { status: "present"; entries: Map<string, SnapshotEntryFingerprint> }
  | { status: "missing" }
  | ScanFailure
> {
  const absDir = dirRel === "" ? rootAbs : join(rootAbs, ...dirRel.split("/"));

  let preStat: WatcherSnapshotStat;
  try {
    preStat = await fs.lstat(absDir);
  } catch (cause) {
    if (isMissingFsError(cause)) {
      return { status: "missing" };
    }
    return { status: "scan_failed", cause };
  }

  if (!isRealDirectory(preStat)) {
    return {
      status: "scan_failed",
      cause: new Error(
        `Expected real directory at ${dirRel || "."}, found ${kindOf(preStat)}`
      ),
    };
  }

  const preIdentity = identityOf(preStat);
  if (preIdentity === null) {
    return { status: "unreliable_metadata" };
  }

  let names: string[];
  try {
    names = await fs.readdir(absDir);
  } catch (cause) {
    if (isMissingFsError(cause)) {
      return { status: "missing" };
    }
    return { status: "scan_failed", cause };
  }

  // Re-verify before any child stats: fail closed on symlink/kind/identity race.
  let postStat: WatcherSnapshotStat;
  try {
    postStat = await fs.lstat(absDir);
  } catch (cause) {
    if (isMissingFsError(cause)) {
      return { status: "missing" };
    }
    return { status: "scan_failed", cause };
  }

  if (!isRealDirectory(postStat)) {
    return {
      status: "scan_failed",
      cause: new Error(
        `Directory became ${kindOf(postStat)} during scan: ${dirRel || "."}`
      ),
    };
  }

  const postIdentity = identityOf(postStat);
  if (postIdentity === null) {
    return { status: "unreliable_metadata" };
  }
  if (
    postIdentity.device !== preIdentity.device ||
    postIdentity.inode !== preIdentity.inode
  ) {
    return {
      status: "scan_failed",
      cause: new Error(
        `Directory identity changed during scan: ${dirRel || "."}`
      ),
    };
  }

  const entries = new Map<string, SnapshotEntryFingerprint>();
  // Stable order keeps overflow selection deterministic across platforms.
  names.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  for (const name of names) {
    if (name === "" || name === "." || name === "..") {
      continue;
    }
    const absPath = join(absDir, name);
    let stat: WatcherSnapshotStat;
    try {
      stat = await fs.lstat(absPath);
    } catch (cause) {
      if (isMissingFsError(cause)) {
        // Race: entry vanished between readdir and lstat — skip, do not fail.
        continue;
      }
      return { status: "scan_failed", cause };
    }
    const fingerprinted = fingerprintFromStat(stat);
    if (!fingerprinted.ok) {
      return { status: "unreliable_metadata" };
    }
    entries.set(name, fingerprinted.fingerprint);
  }
  return { status: "present", entries };
}
