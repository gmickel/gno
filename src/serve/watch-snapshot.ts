/**
 * Watcher-owned hierarchical no-follow filesystem snapshot.
 *
 * Fingerprints identify ambiguous candidates only. They never prove that
 * indexed content is unchanged; exact eligible paths still content-hash.
 *
 * @module src/serve/watch-snapshot
 */

// node:fs/promises — Bun has no readdir/lstat with Dirent/bigint metadata
import {
  lstat as defaultLstat,
  readdir as defaultReaddir,
} from "node:fs/promises";
// node:path — Bun has no path utilities
import { isAbsolute, join, resolve, sep } from "node:path";

/** Fixed service-wide maximum entries retained in one collection snapshot. */
export const WATCHER_SNAPSHOT_ENTRY_CEILING = 100_000;

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

export interface WatcherSnapshotFs {
  readdir(absPath: string): Promise<string[]>;
  lstat(absPath: string): Promise<WatcherSnapshotStat>;
}

export interface WatcherSnapshotClock {
  nowMs(): number;
}

export type SnapshotFallbackReason =
  | "overflow"
  | "scan_failed"
  | "unreliable_metadata";

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

export type WatcherSnapshotDiffResult =
  | {
      status: "ok";
      /** Added, changed, or removed file/symlink paths (POSIX, collection-relative). */
      candidates: string[];
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
}

const defaultClock: WatcherSnapshotClock = {
  nowMs: () => performance.now(),
};

const defaultFs: WatcherSnapshotFs = {
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

function toBigInt(value: number | bigint | undefined): bigint | null {
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

function nsFromStat(
  ns: bigint | number | undefined,
  ms: number | undefined
): bigint | null {
  const direct = toBigInt(ns);
  if (direct !== null) {
    return direct;
  }
  if (ms === undefined || !Number.isFinite(ms)) {
    return null;
  }
  // Millisecond fallback keeps a total order when the runtime omits bigint ns.
  return BigInt(Math.round(ms * 1_000_000));
}

function kindOf(stat: WatcherSnapshotStat): SnapshotEntryKind {
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

function fingerprintFromStat(
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
  const mtimeNs = nsFromStat(stat.mtimeNs, stat.mtimeMs);
  const ctimeNs = nsFromStat(stat.ctimeNs, stat.ctimeMs);
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
  return { directories: new Map(), entryCount: 0 };
}

function cloneDirectoryMaps(
  source: WatcherSnapshot
): Map<string, Map<string, SnapshotEntryFingerprint>> {
  const next = new Map<string, Map<string, SnapshotEntryFingerprint>>();
  for (const [dir, entries] of source.directories) {
    next.set(dir, new Map(entries));
  }
  return next;
}

function countEntries(
  directories: Map<string, Map<string, SnapshotEntryFingerprint>>
): number {
  let total = 0;
  for (const entries of directories.values()) {
    total += entries.size;
  }
  return total;
}

function freezeSnapshot(
  directories: Map<string, Map<string, SnapshotEntryFingerprint>>
): WatcherSnapshot {
  const frozen = new Map<
    string,
    ReadonlyMap<string, SnapshotEntryFingerprint>
  >();
  for (const [dir, entries] of directories) {
    frozen.set(dir, entries);
  }
  return {
    directories: frozen,
    entryCount: countEntries(directories),
  };
}

type ScanFailure =
  | { status: "overflow" }
  | { status: "scan_failed"; cause: unknown }
  | { status: "unreliable_metadata" };

function isMissingFsError(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  return code === "ENOENT" || code === "ENOTDIR";
}

async function readDirectChildren(
  rootAbs: string,
  dirRel: string,
  fs: WatcherSnapshotFs
): Promise<
  | { status: "present"; entries: Map<string, SnapshotEntryFingerprint> }
  | { status: "missing" }
  | ScanFailure
> {
  const absDir = dirRel === "" ? rootAbs : join(rootAbs, ...dirRel.split("/"));
  let names: string[];
  try {
    names = await fs.readdir(absDir);
  } catch (cause) {
    if (isMissingFsError(cause)) {
      return { status: "missing" };
    }
    return { status: "scan_failed", cause };
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

  const directories = new Map<string, Map<string, SnapshotEntryFingerprint>>();
  const queue: string[] = [""];

  while (queue.length > 0) {
    const dirRel = queue.shift() as string;
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

    directories.set(dirRel, scanned.entries);
    if (countEntries(directories) > ceiling) {
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
    snapshot: freezeSnapshot(directories),
    durationMs: clock.nowMs() - started,
  };
}

/**
 * Resolve an untrusted hint to the dirty directory that should be diffed.
 * Missing paths climb to the nearest surviving in-root ancestor.
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

  const exists = async (dirRel: string): Promise<boolean | "error"> => {
    const abs =
      dirRel === "" ? rootResolved : join(rootResolved, ...dirRel.split("/"));
    try {
      await fs.lstat(abs);
      return true;
    } catch (cause) {
      if (isMissingFsError(cause)) {
        return false;
      }
      return "error";
    }
  };

  // Climb from the hint itself so a missing nested path lands on the shallowest
  // surviving ancestor (possibly the collection root).
  let cursor: string | null = normalized;
  while (cursor !== null) {
    const presence = await exists(cursor);
    if (presence === "error") {
      return {
        status: "fallback",
        reason: "scan_failed",
        cause: new Error(`Failed to inspect hint path: ${cursor}`),
      };
    }
    if (presence) {
      // If the surviving path is a file/symlink, its parent is the dirty dir.
      if (cursor === "") {
        return { status: "ok", directory: "" };
      }
      const abs = join(rootResolved, ...cursor.split("/"));
      try {
        const stat = await fs.lstat(abs);
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          return { status: "ok", directory: cursor };
        }
        const parent = parentWatcherDir(cursor);
        return { status: "ok", directory: parent ?? "" };
      } catch (cause) {
        if (isMissingFsError(cause)) {
          cursor = parentWatcherDir(cursor);
          continue;
        }
        return { status: "fallback", reason: "scan_failed", cause };
      }
    }
    cursor = parentWatcherDir(cursor);
  }

  // Root itself is missing — still a valid dirty directory for fallback callers.
  return { status: "ok", directory: "" };
}

function directoryIsUnder(dir: string, ancestor: string): boolean {
  if (ancestor === "") {
    return true;
  }
  return dir === ancestor || dir.startsWith(`${ancestor}/`);
}

function removeSubtreeFromMaps(
  directories: Map<string, Map<string, SnapshotEntryFingerprint>>,
  dirRel: string
): string[] {
  const removedCandidates: string[] = [];
  const dirsToDelete: string[] = [];

  for (const [dir, entries] of directories) {
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
    directories.delete(dir);
  }
  return removedCandidates;
}

function collectSnapshotFilesUnder(
  snapshot: WatcherSnapshot,
  dirRel: string
): string[] {
  const out: string[] = [];
  for (const [dir, entries] of snapshot.directories) {
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

type DiffWorkResult = { status: "ok" } | ScanFailure;

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

  const nextDirs = cloneDirectoryMaps(previous);
  const candidates = new Set<string>();
  const visited = new Set<string>();

  const diffDirectory = async (dirRel: string): Promise<DiffWorkResult> => {
    if (visited.has(dirRel)) {
      return { status: "ok" };
    }
    visited.add(dirRel);

    const scanned = await readDirectChildren(rootAbs, dirRel, fs);
    if (scanned.status === "missing") {
      for (const path of collectSnapshotFilesUnder(
        { directories: nextDirs, entryCount: 0 },
        dirRel
      )) {
        candidates.add(path);
      }
      // Also pull from previous in case nextDirs was already partially edited.
      for (const path of collectSnapshotFilesUnder(previous, dirRel)) {
        candidates.add(path);
      }
      removeSubtreeFromMaps(nextDirs, dirRel);
      // Remove the directory entry from its parent map when nested.
      const parent = parentWatcherDir(dirRel);
      if (parent !== null) {
        const parentEntries = nextDirs.get(parent);
        if (parentEntries) {
          const base = dirRel.slice(parent === "" ? 0 : parent.length + 1);
          parentEntries.delete(base);
        }
      }
      return { status: "ok" };
    }
    if (scanned.status !== "present") {
      return scanned;
    }

    const oldEntries = nextDirs.get(dirRel) ?? new Map();
    const newEntries = scanned.entries;
    nextDirs.set(dirRel, new Map(newEntries));

    if (countEntries(nextDirs) > ceiling) {
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
          for (const path of collectSnapshotFilesUnder(previous, childRel)) {
            candidates.add(path);
          }
          // previous may already have been partially cloned; also clear nextDirs.
          for (const path of collectSnapshotFilesUnder(
            { directories: nextDirs, entryCount: 0 },
            childRel
          )) {
            candidates.add(path);
          }
          removeSubtreeFromMaps(nextDirs, childRel);
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
            nextDirs,
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
          for (const path of collectSnapshotFilesUnder(previous, childRel)) {
            candidates.add(path);
          }
          removeSubtreeFromMaps(nextDirs, childRel);
        }
        if (newFp.kind === "directory") {
          // Recurse into changed or newly-directory path.
          if (oldFp.kind !== "directory") {
            const built = await scanNewSubtree(
              rootAbs,
              childRel,
              fs,
              nextDirs,
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

  if (countEntries(nextDirs) > ceiling) {
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
    nextSnapshot: freezeSnapshot(nextDirs),
    discoveryMs: clock.nowMs() - started,
  };
}

async function scanNewSubtree(
  rootAbs: string,
  dirRel: string,
  fs: WatcherSnapshotFs,
  directories: Map<string, Map<string, SnapshotEntryFingerprint>>,
  candidates: Set<string>,
  ceiling: number
): Promise<DiffWorkResult> {
  const queue = [dirRel];
  while (queue.length > 0) {
    const current = queue.shift() as string;
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
    directories.set(current, new Map(scanned.entries));
    if (countEntries(directories) > ceiling) {
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
