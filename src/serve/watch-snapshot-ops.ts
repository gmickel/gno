/**
 * Build and diff orchestration for watcher snapshots.
 * Hint reconciliation lives in `watch-snapshot-resolve`.
 *
 * @module src/serve/watch-snapshot-ops
 */

import type { DirectoryAvailabilityPort } from "../ingestion/source-availability";
import type {
  DiffWorkResult,
  SnapshotEntryFingerprint,
  WatcherSnapshot,
  WatcherSnapshotBuildResult,
  WatcherSnapshotDiffResult,
  WatcherSnapshotFs,
  WatcherSnapshotOptions,
} from "./watch-snapshot-types";

import {
  directoryAllowsDescent,
  readAvailableDirectory,
} from "./watch-snapshot-availability";
import {
  cloneDirectoryMaps,
  defaultClock,
  defaultFs,
  freezeSnapshot,
  removeSubtreeFromMaps,
  setDirectoryEntries,
  type MutableSnapshotMaps,
} from "./watch-snapshot-scan";
import {
  WATCHER_SNAPSHOT_ENTRY_CEILING,
  fingerprintsEqual,
  isWatcherSourceKind,
  joinWatcherRelPath,
  normalizeWatcherRelPath,
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
  const directoryAvailability = options.directoryAvailability;
  const started = clock.nowMs();

  if (!(await directoryAllowsDescent(rootAbs, "", directoryAvailability))) {
    // Root itself is unproven — fail closed without claiming an empty tree.
    return {
      status: "fallback",
      reason: "scan_failed",
      durationMs: clock.nowMs() - started,
      cause: new Error(
        "Collection root availability is unproven; refusing snapshot descent"
      ),
    };
  }

  const state: MutableSnapshotMaps = {
    directories: new Map(),
    entryCount: 0,
    unprovenSubtrees: new Set(),
  };
  // Cursor-index queue avoids O(n) shift on large directory sets.
  const queue: string[] = [""];
  let head = 0;

  while (head < queue.length) {
    const dirRel = queue[head] as string;
    head += 1;
    // Remaining slots before this directory map is installed.
    const remaining = ceiling - state.entryCount;
    if (remaining < 0) {
      return {
        status: "fallback",
        reason: "overflow",
        durationMs: clock.nowMs() - started,
      };
    }
    const scanned = await readAvailableDirectory(
      rootAbs,
      dirRel,
      fs,
      remaining,
      directoryAvailability
    );
    if (scanned.status === "unproven") {
      if (dirRel === "") {
        return {
          status: "fallback",
          reason: "scan_failed",
          durationMs: clock.nowMs() - started,
          cause: new Error(
            "Collection root availability changed before snapshot enumeration"
          ),
        };
      }
      state.unprovenSubtrees.add(dirRel);
      continue;
    }
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
        const childRel = joinWatcherRelPath(dirRel, name);
        if (
          !(await directoryAllowsDescent(
            rootAbs,
            childRel,
            directoryAvailability
          ))
        ) {
          // Refuse descent/enumeration; leave subtree absent from this build.
          state.unprovenSubtrees.add(childRel);
          continue;
        }
        queue.push(childRel);
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
  const directoryAvailability = options.directoryAvailability;
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

  const subtreeInventoryIsUnproven = (dirRel: string): boolean => {
    const prefix = `${dirRel}/`;
    for (const unproven of nextState.unprovenSubtrees) {
      if (unproven === dirRel || unproven.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  };

  const diffDirectory = async (dirRel: string): Promise<DiffWorkResult> => {
    if (visited.has(dirRel)) {
      return { status: "ok" };
    }
    visited.add(dirRel);

    if (
      !(await directoryAllowsDescent(rootAbs, dirRel, directoryAvailability))
    ) {
      // Dirty target is unproven — keep prior subtree, prove nothing.
      return { status: "ok" };
    }

    // Replacement frees prior slots for this directory map before the new scan.
    const previousSize = nextState.directories.get(dirRel)?.size ?? 0;
    const remaining = ceiling - nextState.entryCount + previousSize;
    if (remaining < 0) {
      return { status: "overflow" };
    }
    const scanned = await readAvailableDirectory(
      rootAbs,
      dirRel,
      fs,
      remaining,
      directoryAvailability
    );
    if (scanned.status === "unproven") {
      return { status: "ok" };
    }
    if (scanned.status === "missing") {
      // Open-time ENOENT/ENOTDIR is never directory-deletion proof.
      // A nested dirty target may have raced into a file/symlink/other after
      // resolve, and recursive open may disagree with a parent listing that
      // still observed a directory — both are inconsistent scans. Deletion is
      // proven only when a successful containing-parent listing observes the
      // child absent (handled via oldFp && !newFp below).
      return {
        status: "scan_failed",
        cause: new Error(
          dirRel === ""
            ? "Collection root is missing"
            : `Directory open failed (missing or not a directory): ${dirRel}`
        ),
      };
    }
    if (scanned.status !== "present") {
      return scanned;
    }

    const oldEntries =
      nextState.directories.get(dirRel) ??
      new Map<string, SnapshotEntryFingerprint>();
    const newEntries = scanned.entries;
    setDirectoryEntries(nextState, dirRel, new Map(newEntries));
    nextState.unprovenSubtrees.delete(dirRel);

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
        // `other` was never an indexable source — drop fingerprint only.
        if (oldFp.kind === "directory") {
          if (subtreeInventoryIsUnproven(childRel)) {
            return { status: "unproven_subtree" };
          }
          recordSubtreeRemovals(childRel);
        } else if (isWatcherSourceKind(oldFp.kind)) {
          removals.add(childRel);
        }
        continue;
      }

      if (newFp && !oldFp) {
        // Added entry. Candidates are file/symlink only — ignore new FIFO/etc.
        if (newFp.kind === "directory") {
          if (
            !(await directoryAllowsDescent(
              rootAbs,
              childRel,
              directoryAvailability
            ))
          ) {
            // Unproven new directory: keep fingerprint, do not enumerate.
            continue;
          }
          const built = await scanNewSubtree(
            rootAbs,
            childRel,
            fs,
            nextState,
            candidates,
            ceiling,
            directoryAvailability
          );
          if (built.status !== "ok") {
            return built;
          }
        } else if (isWatcherSourceKind(newFp.kind)) {
          candidates.add(childRel);
        }
        // new `other`: fingerprint retained for future transitions; no candidate.
        continue;
      }

      if (oldFp && newFp && !fingerprintsEqual(oldFp, newFp)) {
        // Changed entry — handle kind transitions with the other-kind contract.
        if (oldFp.kind === "directory" && newFp.kind !== "directory") {
          // Directory → file/symlink/other: expand nested indexable removals.
          if (subtreeInventoryIsUnproven(childRel)) {
            return { status: "unproven_subtree" };
          }
          recordSubtreeRemovals(childRel);
          if (isWatcherSourceKind(newFp.kind)) {
            candidates.add(childRel);
          }
          // directory → other: no candidate for the special entry.
          continue;
        }

        if (oldFp.kind !== "directory" && newFp.kind === "directory") {
          // File/symlink → directory: old source is removable.
          // Other → directory: prior other was never indexed — no removal.
          if (isWatcherSourceKind(oldFp.kind)) {
            removals.add(childRel);
          }
          if (
            !(await directoryAllowsDescent(
              rootAbs,
              childRel,
              directoryAvailability
            ))
          ) {
            continue;
          }
          const built = await scanNewSubtree(
            rootAbs,
            childRel,
            fs,
            nextState,
            candidates,
            ceiling,
            directoryAvailability
          );
          if (built.status !== "ok") {
            return built;
          }
          continue;
        }

        if (newFp.kind === "directory") {
          // Directory → directory (metadata change): recurse only when available.
          if (
            !(await directoryAllowsDescent(
              rootAbs,
              childRel,
              directoryAvailability
            ))
          ) {
            // Preserve prior subtree under unproven directory — do not re-scan.
            continue;
          }
          const nested = await diffDirectory(childRel);
          if (nested.status !== "ok") {
            return nested;
          }
          continue;
        }

        // Both non-directory.
        if (
          isWatcherSourceKind(oldFp.kind) &&
          isWatcherSourceKind(newFp.kind)
        ) {
          // file↔symlink or metadata change on an indexable source.
          candidates.add(childRel);
        } else if (isWatcherSourceKind(oldFp.kind) && newFp.kind === "other") {
          // file/symlink → other: remove old path; special entry is not a candidate.
          removals.add(childRel);
        } else if (oldFp.kind === "other" && isWatcherSourceKind(newFp.kind)) {
          // other → file/symlink: new source is a candidate.
          candidates.add(childRel);
        }
        // other → other (metadata): fingerprint only.
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
  ceiling: number,
  directoryAvailability?: DirectoryAvailabilityPort
): Promise<DiffWorkResult> {
  if (!(await directoryAllowsDescent(rootAbs, dirRel, directoryAvailability))) {
    // Keep the directory fingerprint from the parent listing; do not enumerate.
    state.unprovenSubtrees.add(dirRel);
    return { status: "ok" };
  }
  const queue = [dirRel];
  let head = 0;
  while (head < queue.length) {
    const current = queue[head] as string;
    head += 1;
    const previousSize = state.directories.get(current)?.size ?? 0;
    const remaining = ceiling - state.entryCount + previousSize;
    if (remaining < 0) {
      return { status: "overflow" };
    }
    const scanned = await readAvailableDirectory(
      rootAbs,
      current,
      fs,
      remaining,
      directoryAvailability
    );
    if (scanned.status === "unproven") {
      state.unprovenSubtrees.add(current);
      continue;
    }
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
    state.unprovenSubtrees.delete(current);
    if (state.entryCount > ceiling) {
      return { status: "overflow" };
    }
    for (const [name, fingerprint] of scanned.entries) {
      const childRel = joinWatcherRelPath(current, name);
      if (fingerprint.kind === "directory") {
        if (
          !(await directoryAllowsDescent(
            rootAbs,
            childRel,
            directoryAvailability
          ))
        ) {
          state.unprovenSubtrees.add(childRel);
          continue;
        }
        queue.push(childRel);
      } else if (isWatcherSourceKind(fingerprint.kind)) {
        candidates.add(childRel);
      }
      // Nested `other` under a new directory: fingerprint only, never a candidate.
    }
  }
  return { status: "ok" };
}
