/**
 * Watcher snapshot types, fingerprints, and pure path helpers.
 *
 * @module src/serve/watch-snapshot-types
 */

// node:path — Bun has no path utilities
import { isAbsolute } from "node:path";

import type { DirectoryAvailabilityPort } from "../ingestion/source-availability";

/** Fixed service-wide maximum entries retained in one collection snapshot. */
export const WATCHER_SNAPSHOT_ENTRY_CEILING = 100_000;

/**
 * Result of a bounded directory enumeration.
 * Overflow means more than `maxNames` child names were observed; callers must
 * not treat a partial name list as a successful directory image.
 */
export type WatcherReadDirResult =
  | { status: "ok"; names: string[] }
  | { status: "overflow" };

export type SnapshotEntryKind = "file" | "directory" | "symlink" | "other";

/**
 * No-follow entry fingerprint used only for candidate discovery.
 * Equality of fingerprints means "not a discovery candidate", never
 * "content is unchanged".
 */
export interface SnapshotEntryFingerprint {
  kind: SnapshotEntryKind;
  device: bigint;
  inode: bigint;
  size: number;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

/** Hierarchical snapshot indexed by directory (POSIX collection-relative). */
export interface WatcherSnapshot {
  /** dirRelPath → (entry name → fingerprint). `""` is the collection root. */
  readonly directories: ReadonlyMap<
    string,
    ReadonlyMap<string, SnapshotEntryFingerprint>
  >;
  /** Total no-follow entries across every directory map. */
  readonly entryCount: number;
  /**
   * Directory roots observed in a parent listing but not enumerated because
   * source availability was unproven. Their stored descendant inventory is
   * incomplete, so a later proven removal requires full reconciliation.
   */
  readonly unprovenSubtrees?: ReadonlySet<string>;
}

/** Injectable lstat view. `unreliable` forces the correctness-preserving fallback. */
export interface WatcherSnapshotStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  dev: number | bigint;
  ino: number | bigint;
  size: number | bigint;
  mtimeNs?: bigint | number;
  ctimeNs?: bigint | number;
  mtimeMs?: number;
  ctimeMs?: number;
  /** When true, metadata cannot be trusted for discovery. */
  unreliable?: boolean;
}

/**
 * Opaque directory handle for anchored (openat-style) enumeration.
 * Production pins a real directory inode; tests may use path-backed handles.
 */
export type WatcherDirHandle = {
  readonly __watcherDirHandle: unique symbol;
};

/**
 * Injectable filesystem surface for watcher snapshots.
 *
 * Production must set `supportsAnchoredHandles` and implement handle ops so
 * child metadata is resolved relative to a stable directory fd (no path
 * re-walk after the parent is opened). When handles are unavailable, scans
 * return `scan_failed` / `unreliable_metadata` rather than claiming
 * strict no-follow safety.
 */
export interface WatcherSnapshotFs {
  /**
   * True only when openDir/readDir/lstatChild/openChildDir/closeDir form a
   * safe anchored scan path for this runtime/platform.
   */
  readonly supportsAnchoredHandles: boolean;

  /** Open an absolute path as a real directory without following a final symlink. */
  openDir(absPath: string): Promise<WatcherDirHandle>;

  /**
   * Enumerate direct child names via the open directory handle, capped at
   * `maxNames`. Implementations must stop after observing `maxNames + 1`
   * names (overflow) without storing or returning more, and must not claim
   * success with a truncated list.
   */
  readDir(
    handle: WatcherDirHandle,
    maxNames: number
  ): Promise<WatcherReadDirResult>;

  /**
   * No-follow lstat of a direct child relative to an open directory handle.
   * Must not re-resolve intermediate path components outside the handle.
   */
  lstatChild(
    handle: WatcherDirHandle,
    name: string
  ): Promise<WatcherSnapshotStat>;

  /**
   * Open a direct child as a real directory relative to the parent handle
   * (no-follow). Rejects symlink children.
   */
  openChildDir(
    handle: WatcherDirHandle,
    name: string
  ): Promise<WatcherDirHandle>;

  /** Deterministic close; safe to call once per open. */
  closeDir(handle: WatcherDirHandle): Promise<void>;

  /**
   * Optional production-grade synchronous scan used only while a process-wide
   * no-materialization policy is active. Missing support fails local mode closed.
   */
  readDirectChildrenSync?: (
    rootAbs: string,
    dirRel: string,
    maxEntries: number
  ) =>
    | { status: "present"; entries: Map<string, SnapshotEntryFingerprint> }
    | { status: "missing" }
    | ScanFailure;

  /** Synchronous anchored child lstat for guarded local-mode presence checks. */
  lstatChildByRelSync?: (
    rootAbs: string,
    parentRel: string,
    name: string
  ) => WatcherSnapshotStat;
}

export interface WatcherSnapshotClock {
  nowMs(): number;
}

/** Test/prod hooks for map-visit complexity instrumentation. */
export interface SnapshotMapHooks {
  /** Invoked once per directory-map visit during hierarchical subtree walks. */
  onDirectoryMapVisit?: () => void;
}

export type SnapshotFallbackReason =
  | "overflow"
  | "scan_failed"
  | "unreliable_metadata"
  | "unproven_subtree";

export type WatcherSnapshotBuildResult =
  | {
      status: "ok";
      snapshot: WatcherSnapshot;
      durationMs: number;
    }
  | {
      status: "fallback";
      reason: SnapshotFallbackReason;
      durationMs: number;
      cause?: unknown;
    };

/** True when a snapshot entry kind can be an indexed document source. */
export function isWatcherSourceKind(
  kind: SnapshotEntryKind
): kind is "file" | "symlink" {
  return kind === "file" || kind === "symlink";
}

export type WatcherSnapshotDiffResult =
  | {
      status: "ok";
      /**
       * Present/changed file and symlink paths that still exist and need
       * content-hash consideration (added, edited, or new under a directory).
       * Never includes `other` (FIFO/socket/device) or directories.
       * Does not include proven removals.
       */
      candidates: string[];
      /**
       * Proven removable source paths: deleted files/symlinks, prior files
       * replaced by a directory or other special entry, and expanded nested
       * files under removed or directory→non-directory transitions.
       * Never includes `other` entries (they were never indexed as sources).
       */
      removals: string[];
      nextSnapshot: WatcherSnapshot;
      discoveryMs: number;
    }
  | {
      status: "fallback";
      reason: SnapshotFallbackReason;
      discoveryMs: number;
      cause?: unknown;
    };

export interface WatcherSnapshotOptions {
  fs?: WatcherSnapshotFs;
  clock?: WatcherSnapshotClock;
  /** Override the service-wide ceiling (tests only). */
  entryCeiling?: number;
  /** Map-visit instrumentation (tests / complexity regression). */
  mapHooks?: SnapshotMapHooks;
  /**
   * Optional directory-availability classifier for local-mode collections.
   * When set, dataless / availability-unknown directories are not descended;
   * previously observed subtrees are preserved rather than proven removed.
   */
  directoryAvailability?: DirectoryAvailabilityPort;
}

export type ScanFailure =
  | { status: "overflow" }
  | { status: "scan_failed"; cause: unknown }
  | { status: "unreliable_metadata" };

export type DiffWorkResult =
  | { status: "ok" }
  | ScanFailure
  | { status: "unproven_subtree" };

export function toBigInt(value: number | bigint | undefined): bigint | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value === "bigint") {
    return value;
  }
  if (!Number.isFinite(value)) {
    return null;
  }
  return BigInt(Math.trunc(value));
}

/**
 * Require actual finite nanosecond timestamps. Millisecond fields alone are
 * insufficient for the fast path (no ms→ns fabrication).
 */
export function nsFromStat(ns: bigint | number | undefined): bigint | null {
  return toBigInt(ns);
}

export function kindOf(stat: WatcherSnapshotStat): SnapshotEntryKind {
  if (stat.isSymbolicLink()) {
    return "symlink";
  }
  if (stat.isDirectory()) {
    return "directory";
  }
  if (stat.isFile()) {
    return "file";
  }
  return "other";
}

export function fingerprintFromStat(
  stat: WatcherSnapshotStat
):
  | { ok: true; fingerprint: SnapshotEntryFingerprint }
  | { ok: false; reason: "unreliable_metadata" } {
  if (stat.unreliable) {
    return { ok: false, reason: "unreliable_metadata" };
  }
  const device = toBigInt(stat.dev);
  const inode = toBigInt(stat.ino);
  const sizeValue = toBigInt(stat.size);
  const mtimeNs = nsFromStat(stat.mtimeNs);
  const ctimeNs = nsFromStat(stat.ctimeNs);
  if (
    device === null ||
    inode === null ||
    sizeValue === null ||
    mtimeNs === null ||
    ctimeNs === null
  ) {
    return { ok: false, reason: "unreliable_metadata" };
  }
  // size may exceed Number.MAX_SAFE_INTEGER on huge files; clamp via Number is
  // fine for discovery equality against the same platform read.
  const size =
    sizeValue > BigInt(Number.MAX_SAFE_INTEGER)
      ? Number.MAX_SAFE_INTEGER
      : Number(sizeValue);
  return {
    ok: true,
    fingerprint: {
      kind: kindOf(stat),
      device,
      inode,
      size,
      mtimeNs,
      ctimeNs,
    },
  };
}

export function fingerprintsEqual(
  left: SnapshotEntryFingerprint,
  right: SnapshotEntryFingerprint
): boolean {
  return (
    left.kind === right.kind &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/**
 * Normalize an untrusted watcher hint to a POSIX collection-relative path.
 * Returns null for absolute, escaping, empty-invalid, or NUL-bearing values.
 */
export function normalizeWatcherRelPath(relPath: string): string | null {
  if (relPath.includes("\0")) {
    return null;
  }
  const normalized = relPath.replaceAll("\\", "/");
  if (normalized.startsWith("/") || isAbsolute(relPath)) {
    return null;
  }
  // Windows drive-shaped absolute escapes (`C:/...`) after slash normalization.
  if (/^[A-Za-z]:(\/|$)/.test(normalized)) {
    return null;
  }
  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      return null;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

/** Parent directory of a POSIX relative path; `null` when path is the root. */
export function parentWatcherDir(relPath: string): string | null {
  if (relPath === "") {
    return null;
  }
  const index = relPath.lastIndexOf("/");
  return index === -1 ? "" : relPath.slice(0, index);
}

export function joinWatcherRelPath(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

export function createEmptyWatcherSnapshot(): WatcherSnapshot {
  return {
    directories: new Map(),
    entryCount: 0,
    unprovenSubtrees: new Set(),
  };
}

export function isMissingFsError(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  return code === "ENOENT" || code === "ENOTDIR";
}

export function sortPathList(paths: Iterable<string>): string[] {
  return [...paths].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
}
