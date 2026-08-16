/**
 * Shared constants and pure helpers for watcher reconciliation.
 *
 * @module src/serve/watch-reconciliation-shared
 */

// node:fs/promises — structure ops; no Bun equivalent for no-follow lstat
import { lstat } from "node:fs/promises";
// node:path — Bun has no path utilities
import { join, normalize } from "node:path";

import type { Collection } from "../config/types";
import type { CollectionSyncResult } from "../ingestion";

import { matchesCollectionExclusion } from "../core/path-rules";
import {
  collectionToWalkConfig,
  isSourceAvailabilitySkip,
  matchesWalkPath,
} from "../ingestion";
import {
  normalizeWatcherRelPath,
  parentWatcherDir,
  type WatcherSnapshot,
} from "./watch-snapshot";

/** Quiet period before a collection flushes queued watcher work. */
export const WATCHER_FLUSH_DEBOUNCE_MS = 300;

/**
 * Hard ceiling on how long resettable debounce may postpone a flush.
 * Sustained unique-temp churn re-arms debounce; this deadline forces drain.
 */
export const WATCHER_MAX_FLUSH_DELAY_MS = 2_000;

/** Cap on pending exact eligible paths per collection. */
export const WATCHER_MAX_EXACT_PATHS = 8_192;

/** Cap on pending dirty-directory hints per collection. */
export const WATCHER_MAX_DIRTY_HINTS = 4_096;

/** Cap on application-write suppression history entries. */
export const WATCHER_MAX_SUPPRESSION_ENTRIES = 4_096;

/** Bounded retry delay after failed classification/sync. */
export const WATCHER_RETRY_BACKOFF_MS = 500;

/**
 * Single fixed budget for fallback classification across visited directories,
 * candidates, removals, dirty dirs, and aggregate store rows.
 */
export const WATCHER_FALLBACK_BUDGET = 8_192;

export type WatcherEventClassification =
  | { kind: "reject" }
  | { kind: "ignore" }
  | { kind: "exact"; relPath: string }
  | { kind: "dirty"; hint: string };

/** No-follow entry kind for exact-path widening (file/symlink stay exact). */
export type ExactPathKind = "file" | "directory" | "symlink" | "other";

export type PathPresence =
  | { status: "present"; kind: ExactPathKind }
  | { status: "missing" }
  | { status: "error"; cause: unknown };

export type ClassificationFullReconcileReason =
  | "unsupported_fs"
  | "budget_overflow"
  | "snapshot_overflow"
  | "snapshot_unproven_subtree";

export type ClassificationResult =
  | {
      status: "ok";
      candidates: string[];
      removals: string[];
      nextSnapshot: WatcherSnapshot | null;
      usedFallback: boolean;
    }
  | {
      /**
       * Durable full-collection reconciliation required (unsupported FS,
       * classification budget overflow, or snapshot ceiling overflow).
       * Callers must use syncCollection — never retry the identical dirty scan.
       */
      status: "full_reconcile";
      reason: ClassificationFullReconcileReason;
    }
  | {
      status: "error";
      cause: unknown;
      stage: "scan" | "store";
    };

/** Paths that successfully changed during a sync (added/updated only). */
export function successfulChangedPaths(result: CollectionSyncResult): string[] {
  if (result.files) {
    return result.files
      .filter((file) => file.status === "added" || file.status === "updated")
      .map((file) => file.relPath);
  }
  return [];
}

/**
 * Paths that failed during a sync. When file-level detail is missing, falls
 * back to every submitted path so work is never silently dropped.
 */
export function failedSyncPaths(
  result: CollectionSyncResult,
  submittedPaths: readonly string[]
): string[] {
  if (result.files && result.files.length > 0) {
    return result.files
      .filter((file) => file.status === "error")
      .map((file) => file.relPath);
  }
  if (result.errors.length > 0) {
    const fromErrors = result.errors
      .map((entry) => entry.relPath)
      .filter((path) => path.length > 0);
    if (fromErrors.length > 0) {
      return [...new Set(fromErrors)];
    }
  }
  return [...submittedPaths];
}

/**
 * Classify an untrusted watcher filename for one collection.
 * Rejects absolute/escaping/NUL paths before joins or suppression lookups.
 * Permanently excluded subtrees are ignored when safely classifiable.
 */
export function classifyWatcherFilename(
  filename: string | Buffer | null | undefined,
  collection: Collection
): WatcherEventClassification {
  if (filename === null || filename === undefined) {
    return { kind: "dirty", hint: "" };
  }
  const raw = filename.toString();
  if (raw.length === 0) {
    return { kind: "dirty", hint: "" };
  }

  const relPath = normalizeWatcherRelPath(raw.replaceAll("\\", "/"));
  if (relPath === null) {
    return { kind: "reject" };
  }

  const walkConfig = collectionToWalkConfig(collection, 0);
  if (
    relPath !== "" &&
    matchesCollectionExclusion(relPath, walkConfig.exclude)
  ) {
    return { kind: "ignore" };
  }

  if (relPath === "") {
    return { kind: "dirty", hint: "" };
  }

  if (matchesWalkPath(relPath, walkConfig)) {
    return { kind: "exact", relPath };
  }

  return { kind: "dirty", hint: relPath };
}

/** True when any per-file result is an error (partial sync must not commit). */
export function hasFileLevelSyncError(result: CollectionSyncResult): boolean {
  if (result.filesErrored > 0) {
    return true;
  }
  if (result.files?.some((file) => file.status === "error")) {
    return true;
  }
  return result.errors.some((error) => !isSourceAvailabilitySkip(error.code));
}

/**
 * Add `value` to a capped set. Overflow signals callers to degrade to
 * bounded fallback (e.g. root dirty) rather than drop work silently.
 */
export function addToCappedSet(
  set: Set<string>,
  value: string,
  max: number
): "added" | "exists" | "overflow" {
  if (set.has(value)) {
    return "exists";
  }
  if (set.size >= max) {
    return "overflow";
  }
  set.add(value);
  return "added";
}

/** Prune expired suppression entries; enforce a hard size ceiling. */
export function pruneSuppressionMap(
  map: Map<string, number>,
  nowMs: number,
  maxEntries: number
): void {
  for (const [key, until] of map) {
    if (until <= nowMs) {
      map.delete(key);
    }
  }
  if (map.size <= maxEntries) {
    return;
  }
  const ordered = [...map.entries()].sort((a, b) => a[1] - b[1]);
  const drop = map.size - maxEntries;
  for (let i = 0; i < drop; i += 1) {
    const key = ordered[i]?.[0];
    if (key !== undefined) {
      map.delete(key);
    }
  }
}

function kindFromLstat(info: {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
}): ExactPathKind {
  if (info.isSymbolicLink()) {
    return "symlink";
  }
  if (info.isDirectory()) {
    return "directory";
  }
  if (info.isFile()) {
    return "file";
  }
  // FIFO / socket / device — never indexable file sources.
  return "other";
}

/**
 * Contained no-follow presence check for exact-path widening.
 * Uses lstat so symlink vs directory vs special (FIFO/socket/device) is exact.
 */
export async function inspectPathPresence(
  rootAbs: string,
  relPath: string
): Promise<PathPresence> {
  const abs = normalize(join(rootAbs, ...relPath.split("/").filter(Boolean)));
  try {
    const info = await lstat(abs);
    return { status: "present", kind: kindFromLstat(info) };
  } catch (cause) {
    const code =
      cause && typeof cause === "object" && "code" in cause
        ? String(cause.code)
        : "";
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { status: "missing" };
    }
    return { status: "error", cause };
  }
}

/**
 * Widen exact eligible paths before targeted sync.
 *
 * - Regular file / symlink sources stay exact (content-hash authority).
 * - Directory or non-indexable special (FIFO/socket/device) leave exact and
 *   become dirty-only so snapshot/fallback can prove removals + children.
 * - Missing paths keep exact (ENOENT inactivation) and dirty parent discovery.
 * - Uncertain lstat failures never stay exact-only (avoids NOT_FILE loops);
 *   they dirty + force fallback for durable reclassification.
 */
export async function widenVanishedExactPaths(
  rootAbs: string,
  exactPaths: readonly string[]
): Promise<{
  keepExact: string[];
  extraDirty: string[];
  /** Non-source present paths (dir/other) or uncertain — force store/disk. */
  directoryDirty: string[];
}> {
  const keepExact: string[] = [];
  const extraDirty: string[] = [];
  const directoryDirty: string[] = [];
  for (const relPath of exactPaths) {
    const presence = await inspectPathPresence(rootAbs, relPath);
    if (presence.status === "error") {
      // Uncertainty: durable dirty/full path — never exact NOT_FILE churn.
      extraDirty.push(relPath);
      directoryDirty.push(relPath);
      const parent = parentWatcherDir(relPath);
      if (parent !== null) {
        extraDirty.push(parent);
      }
      continue;
    }
    if (presence.status === "missing") {
      keepExact.push(relPath);
      extraDirty.push(relPath);
      const parent = parentWatcherDir(relPath);
      if (parent !== null) {
        extraDirty.push(parent);
      }
      continue;
    }
    if (presence.kind === "directory" || presence.kind === "other") {
      // Not an indexable file source; dirty-only so proven removals can land.
      extraDirty.push(relPath);
      directoryDirty.push(relPath);
      continue;
    }
    // file | symlink — retain exact content-hash authority.
    keepExact.push(relPath);
  }
  return { keepExact, extraDirty, directoryDirty };
}

export function filterEligiblePaths(
  paths: readonly string[],
  collection: Collection
): string[] {
  const walkConfig = collectionToWalkConfig(collection, 0);
  return paths.filter((relPath) => matchesWalkPath(relPath, walkConfig));
}

/** Merge exact + reconciled paths into one deduped targeted batch (sorted). */
export function mergeSyncPathBatch(
  exactPaths: readonly string[],
  candidates: readonly string[],
  removals: readonly string[]
): string[] {
  const batch = new Set<string>();
  for (const path of exactPaths) {
    batch.add(path);
  }
  for (const path of candidates) {
    batch.add(path);
  }
  for (const path of removals) {
    batch.add(path);
  }
  return [...batch].sort();
}
