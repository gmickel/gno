/**
 * Build / diff / reconcile orchestration for watcher snapshots.
 *
 * @module src/serve/watch-snapshot-ops
 */

import type {
  DiffWorkResult,
  SnapshotEntryFingerprint,
  WatcherSnapshot,
  WatcherSnapshotBuildResult,
  WatcherSnapshotDiffResult,
  WatcherSnapshotFs,
  WatcherSnapshotOptions,
} from "./watch-snapshot-types";

import { resolveWatcherDirtyDirectory } from "./watch-snapshot-resolve";
import {
  cloneDirectoryMaps,
  collectSnapshotFilesUnder,
  defaultClock,
  defaultFs,
  freezeSnapshot,
  readDirectChildren,
  removeSubtreeFromMaps,
  setDirectoryEntries,
  type MutableSnapshotMaps,
} from "./watch-snapshot-scan";
import {
  WATCHER_SNAPSHOT_ENTRY_CEILING,
  fingerprintsEqual,
  joinWatcherRelPath,
  normalizeWatcherRelPath,
  parentWatcherDir,
} from "./watch-snapshot-types";

/**
 * Build a full no-follow hierarchical snapshot of `rootAbs`.
 * On overflow, scan failure, or unreliable metadata the last proven snapshot
 * is untouched (this function simply does not return one).
 */
export async function buildWatcherSnapshot(
  rootAbs: string,
  options: WatcherSnapshotOptions = {}
): Promise<WatcherSnapshotBuildResult> {
  const fs = options.fs ?? defaultFs;
  const clock = options.clock ?? defaultClock;
  const ceiling = options.entryCeiling ?? WATCHER_SNAPSHOT_ENTRY_CEILING;
  const started = clock.nowMs();

  const state: MutableSnapshotMaps = {
    directories: new Map(),
    entryCount: 0,
  };
  // Cursor-index queue avoids O(n) shift on large directory sets.
  const queue: string[] = [""];
  let head = 0;

  while (head < queue.length) {
    const dirRel = queue[head] as string;
    head += 1;
    const scanned = await readDirectChildren(rootAbs, dirRel, fs);
    if (scanned.status === "missing") {
      if (dirRel === "") {
        return {
          status: "fallback",
          reason: "scan_failed",
          durationMs: clock.nowMs() - started,
          cause: new Error("Collection root is missing"),
        };
      }
      // Nested directory vanished mid-scan: fail closed rather than prove removals.
      return {
        status: "fallback",
        reason: "scan_failed",
        durationMs: clock.nowMs() - started,
        cause: new Error(`Directory vanished during snapshot: ${dirRel}`),
      };
    }
    if (scanned.status !== "present") {
      return {
        status: "fallback",
        reason: scanned.status,
        durationMs: clock.nowMs() - started,
        cause: scanned.status === "scan_failed" ? scanned.cause : undefined,
      };
    }

    setDirectoryEntries(state, dirRel, scanned.entries);
    if (state.entryCount > ceiling) {
      return {
        status: "fallback",
        reason: "overflow",
        durationMs: clock.nowMs() - started,
      };
    }

    for (const [name, fingerprint] of scanned.entries) {
      // No-follow: never recurse through symlinks (even if they point inside root).
      if (fingerprint.kind === "directory") {
        queue.push(joinWatcherRelPath(dirRel, name));
      }
    }
  }

  return {
    status: "ok",
    snapshot: freezeSnapshot(state),
    durationMs: clock.nowMs() - started,
  };
}

/**
 * Diff one or more dirty directories against the last proven snapshot.
 *
 * - Compares direct children only
 * - Recurses into changed or new real directories
 * - Expands removals from the old snapshot
 * - Never mutates `previous`; overflow/failure leaves it as the last proven state
 */
export async function diffWatcherSnapshot(
  rootAbs: string,
  previous: WatcherSnapshot,
  dirtyDirectories: readonly string[],
  options: WatcherSnapshotOptions = {}
): Promise<WatcherSnapshotDiffResult> {
  const fs = options.fs ?? defaultFs;
  const clock = options.clock ?? defaultClock;
  const ceiling = options.entryCeiling ?? WATCHER_SNAPSHOT_ENTRY_CEILING;
  const started = clock.nowMs();

  const normalizedDirs: string[] = [];
  for (const raw of dirtyDirectories) {
    const normalized = normalizeWatcherRelPath(raw === "" ? "." : raw);
    // `normalizeWatcherRelPath(".")` → `""`; empty string is the root and is
    // already valid. Accept explicit "" without going through normalize of "".
    if (raw === "") {
      normalizedDirs.push("");
      continue;
    }
    if (normalized === null) {
      // Invalid dirty directory: ignore as a no-op rather than failing the batch.
      // Callers should resolve hints first; this guard keeps the primitive safe.
      continue;
    }
    normalizedDirs.push(normalized);
  }

  if (normalizedDirs.length === 0) {
    return {
      status: "ok",
      candidates: [],
      nextSnapshot: previous,
      discoveryMs: clock.nowMs() - started,
    };
  }

  const nextState = cloneDirectoryMaps(previous);
  const candidates = new Set<string>();
  const visited = new Set<string>();

  const diffDirectory = async (dirRel: string): Promise<DiffWorkResult> => {
    if (visited.has(dirRel)) {
      return { status: "ok" };
    }
    visited.add(dirRel);

    const scanned = await readDirectChildren(rootAbs, dirRel, fs);
    if (scanned.status === "missing") {
      // Missing collection root is never a successful mass-deletion proof.
      if (dirRel === "") {
        return {
          status: "scan_failed",
          cause: new Error("Collection root is missing"),
        };
      }
      for (const path of collectSnapshotFilesUnder(
        nextState.directories,
        dirRel
      )) {
        candidates.add(path);
      }
      // Also pull from previous in case nextState was already partially edited.
      for (const path of collectSnapshotFilesUnder(
        previous.directories,
        dirRel
      )) {
        candidates.add(path);
      }
      removeSubtreeFromMaps(nextState, dirRel);
      // Remove the directory entry from its parent map when nested.
      const parent = parentWatcherDir(dirRel);
      if (parent !== null) {
        const parentEntries = nextState.directories.get(parent);
        if (parentEntries) {
          const base = dirRel.slice(parent === "" ? 0 : parent.length + 1);
          if (parentEntries.delete(base)) {
            nextState.entryCount -= 1;
          }
        }
      }
      return { status: "ok" };
    }
    if (scanned.status !== "present") {
      return scanned;
    }

    const oldEntries =
      nextState.directories.get(dirRel) ??
      new Map<string, SnapshotEntryFingerprint>();
    const newEntries = scanned.entries;
    setDirectoryEntries(nextState, dirRel, new Map(newEntries));

    if (nextState.entryCount > ceiling) {
      return { status: "overflow" };
    }

    const names = new Set([...oldEntries.keys(), ...newEntries.keys()]);
    for (const name of names) {
      const oldFp = oldEntries.get(name);
      const newFp = newEntries.get(name);
      const childRel = joinWatcherRelPath(dirRel, name);

      if (oldFp && !newFp) {
        // Removed entry: expand prior subtree for directories; files/symlinks directly.
        if (oldFp.kind === "directory") {
          for (const path of collectSnapshotFilesUnder(
            previous.directories,
            childRel
          )) {
            candidates.add(path);
          }
          // previous may already have been partially cloned; also clear nextState.
          for (const path of collectSnapshotFilesUnder(
            nextState.directories,
            childRel
          )) {
            candidates.add(path);
          }
          removeSubtreeFromMaps(nextState, childRel);
        } else {
          candidates.add(childRel);
        }
        continue;
      }

      if (newFp && !oldFp) {
        // Added entry.
        if (newFp.kind === "directory") {
          const built = await scanNewSubtree(
            rootAbs,
            childRel,
            fs,
            nextState,
            candidates,
            ceiling
          );
          if (built.status !== "ok") {
            return built;
          }
        } else {
          candidates.add(childRel);
        }
        continue;
      }

      if (oldFp && newFp && !fingerprintsEqual(oldFp, newFp)) {
        // Changed entry.
        if (oldFp.kind === "directory" && newFp.kind !== "directory") {
          // Directory replaced by file/symlink: prior children are removals.
          for (const path of collectSnapshotFilesUnder(
            previous.directories,
            childRel
          )) {
            candidates.add(path);
          }
          removeSubtreeFromMaps(nextState, childRel);
        }
        if (newFp.kind === "directory") {
          // Recurse into changed or newly-directory path.
          if (oldFp.kind !== "directory") {
            const built = await scanNewSubtree(
              rootAbs,
              childRel,
              fs,
              nextState,
              candidates,
              ceiling
            );
            if (built.status !== "ok") {
              return built;
            }
          } else {
            const nested = await diffDirectory(childRel);
            if (nested.status !== "ok") {
              return nested;
            }
          }
        } else {
          candidates.add(childRel);
        }
      }
      // Equal fingerprints: leave alone (do not recurse into unchanged dirs).
    }

    return { status: "ok" };
  };

  for (const dir of normalizedDirs) {
    const result = await diffDirectory(dir);
    if (result.status !== "ok") {
      return {
        status: "fallback",
        reason: result.status,
        discoveryMs: clock.nowMs() - started,
        cause: result.status === "scan_failed" ? result.cause : undefined,
      };
    }
  }

  if (nextState.entryCount > ceiling) {
    return {
      status: "fallback",
      reason: "overflow",
      discoveryMs: clock.nowMs() - started,
    };
  }

  const sorted = [...candidates].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );

  return {
    status: "ok",
    candidates: sorted,
    nextSnapshot: freezeSnapshot(nextState),
    discoveryMs: clock.nowMs() - started,
  };
}

async function scanNewSubtree(
  rootAbs: string,
  dirRel: string,
  fs: WatcherSnapshotFs,
  state: MutableSnapshotMaps,
  candidates: Set<string>,
  ceiling: number
): Promise<DiffWorkResult> {
  const queue = [dirRel];
  let head = 0;
  while (head < queue.length) {
    const current = queue[head] as string;
    head += 1;
    const scanned = await readDirectChildren(rootAbs, current, fs);
    if (scanned.status === "missing") {
      // New directory vanished while scanning — fail closed.
      return {
        status: "scan_failed",
        cause: new Error(`New directory vanished during scan: ${current}`),
      };
    }
    if (scanned.status !== "present") {
      return scanned;
    }
    setDirectoryEntries(state, current, new Map(scanned.entries));
    if (state.entryCount > ceiling) {
      return { status: "overflow" };
    }
    for (const [name, fingerprint] of scanned.entries) {
      const childRel = joinWatcherRelPath(current, name);
      if (fingerprint.kind === "directory") {
        queue.push(childRel);
      } else {
        candidates.add(childRel);
      }
    }
  }
  return { status: "ok" };
}

/**
 * Resolve dirty directories from untrusted hints, then diff against `previous`.
 * Invalid hints are skipped; if every hint is invalid, returns an empty ok diff.
 * A scan/metadata failure never advances the snapshot.
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
    dirty.add(resolved.directory);
  }

  if (dirty.size === 0) {
    return {
      status: "ok",
      candidates: [],
      nextSnapshot: previous,
      discoveryMs: clock.nowMs() - started,
    };
  }

  return diffWatcherSnapshot(rootAbs, previous, [...dirty], options);
}
