/**
 * Build / diff / reconcile orchestration for watcher snapshots.
 *
 * @module src/serve/watch-snapshot-ops
 */

import type {
  DiffWorkResult,
  SnapshotEntryFingerprint,
  SnapshotMapHooks,
  WatcherSnapshot,
  WatcherSnapshotBuildResult,
  WatcherSnapshotDiffResult,
  WatcherSnapshotFs,
  WatcherSnapshotOptions,
} from "./watch-snapshot-types";

import { resolveWatcherDirtyDirectory } from "./watch-snapshot-resolve";
import {
  cloneDirectoryMaps,
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
  sortPathList,
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
 * - Expands removals hierarchically from the old snapshot (O(subtree))
 * - Emits explicit `removals` separate from present/changed `candidates`
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
  const mapHooks = options.mapHooks;
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
      removals: [],
      nextSnapshot: previous,
      discoveryMs: clock.nowMs() - started,
    };
  }

  const nextState = cloneDirectoryMaps(previous);
  const candidates = new Set<string>();
  const removals = new Set<string>();
  const visited = new Set<string>();

  const recordSubtreeRemovals = (dirRel: string): void => {
    // One hierarchical collect+remove pass — no prior full-map scan.
    for (const path of removeSubtreeFromMaps(nextState, dirRel, mapHooks)) {
      removals.add(path);
    }
  };

  const removeDirEntryFromParent = (dirRel: string): void => {
    const parent = parentWatcherDir(dirRel);
    if (parent === null) {
      return;
    }
    const parentEntries = nextState.directories.get(parent);
    if (!parentEntries) {
      return;
    }
    const base = dirRel.slice(parent === "" ? 0 : parent.length + 1);
    if (parentEntries.delete(base)) {
      nextState.entryCount -= 1;
    }
  };

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
      recordSubtreeRemovals(dirRel);
      removeDirEntryFromParent(dirRel);
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
          recordSubtreeRemovals(childRel);
        } else {
          removals.add(childRel);
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
        // Changed entry — handle kind transitions explicitly.
        if (oldFp.kind === "directory" && newFp.kind !== "directory") {
          // Directory replaced by file/symlink: prior nested sources are removals.
          recordSubtreeRemovals(childRel);
        }

        if (oldFp.kind !== "directory" && newFp.kind === "directory") {
          // File/symlink/other → directory: old source path is explicitly removable.
          // New directory descendants become present candidates via scan.
          removals.add(childRel);
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
          continue;
        }

        if (newFp.kind === "directory") {
          // Directory → directory (metadata change): recurse.
          const nested = await diffDirectory(childRel);
          if (nested.status !== "ok") {
            return nested;
          }
        } else {
          // Non-directory present/changed (including directory→file after removals).
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

  return {
    status: "ok",
    candidates: sortPathList(candidates),
    removals: sortPathList(removals),
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
      removals: [],
      nextSnapshot: previous,
      discoveryMs: clock.nowMs() - started,
    };
  }

  return diffWatcherSnapshot(rootAbs, previous, [...dirty], options);
}

// mapHooks type re-export surface for tests importing options only
export type { SnapshotMapHooks };
