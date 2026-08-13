/**
 * Watcher-owned hierarchical no-follow filesystem snapshot.
 *
 * Fingerprints identify ambiguous candidates only. They never prove that
 * indexed content is unchanged; exact eligible paths still content-hash.
 *
 * Public contract only — implementation is split across focused modules.
 * This facade re-exports the concrete public surface (not an unrelated barrel).
 *
 * @module src/serve/watch-snapshot
 */

export {
  WATCHER_SNAPSHOT_ENTRY_CEILING,
  createEmptyWatcherSnapshot,
  fingerprintsEqual,
  joinWatcherRelPath,
  normalizeWatcherRelPath,
  parentWatcherDir,
} from "./watch-snapshot-types";

export type {
  SnapshotEntryFingerprint,
  SnapshotEntryKind,
  SnapshotFallbackReason,
  SnapshotMapHooks,
  WatcherDirHandle,
  WatcherReadDirResult,
  WatcherSnapshot,
  WatcherSnapshotBuildResult,
  WatcherSnapshotClock,
  WatcherSnapshotDiffResult,
  WatcherSnapshotFs,
  WatcherSnapshotOptions,
  WatcherSnapshotStat,
} from "./watch-snapshot-types";

export {
  buildWatcherSnapshot,
  diffWatcherSnapshot,
} from "./watch-snapshot-ops";

export {
  reconcileWatcherHints,
  resolveWatcherDirtyDirectory,
} from "./watch-snapshot-resolve";

export {
  createPathBackedWatcherFs,
  removeSubtreeFromMaps,
} from "./watch-snapshot-scan";
