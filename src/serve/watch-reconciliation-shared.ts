/**
 * Shared constants and pure helpers for watcher reconciliation.
 *
 * @module src/serve/watch-reconciliation-shared
 */

// node:fs/promises — structure ops; no Bun equivalent for stat
import { stat } from "node:fs/promises";
// node:path — Bun has no path utilities
import { join, normalize } from "node:path";

import type { Collection } from "../config/types";
import type { CollectionSyncResult } from "../ingestion";

import { matchesCollectionExclusion } from "../core/path-rules";
import { collectionToWalkConfig, matchesWalkPath } from "../ingestion";
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

export type WatcherEventClassification =
  | { kind: "reject" }
  | { kind: "ignore" }
  | { kind: "exact"; relPath: string }
  | { kind: "dirty"; hint: string };

export type PathPresence =
  | { status: "present"; isDirectory: boolean }
  | { status: "missing" }
  | { status: "error"; cause: unknown };

export type ClassificationResult =
  | {
      status: "ok";
      candidates: string[];
      removals: string[];
      nextSnapshot: WatcherSnapshot | null;
      usedFallback: boolean;
    }
  | {
      status: "error";
      cause: unknown;
      stage: "scan" | "store";
    };

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
  return result.errors.length > 0;
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

export async function inspectPathPresence(
  rootAbs: string,
  relPath: string
): Promise<PathPresence> {
  const abs = normalize(join(rootAbs, ...relPath.split("/").filter(Boolean)));
  try {
    const info = await stat(abs);
    return { status: "present", isDirectory: info.isDirectory() };
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
 * When an exact eligible path has vanished, also dirty the path (and parent)
 * so recursive-delete siblings can be discovered via snapshot/store fallback.
 */
export async function widenVanishedExactPaths(
  rootAbs: string,
  exactPaths: readonly string[]
): Promise<{ keepExact: string[]; extraDirty: string[] }> {
  const keepExact: string[] = [];
  const extraDirty: string[] = [];
  for (const relPath of exactPaths) {
    const presence = await inspectPathPresence(rootAbs, relPath);
    if (presence.status === "error") {
      keepExact.push(relPath);
      continue;
    }
    keepExact.push(relPath);
    if (presence.status === "missing") {
      extraDirty.push(relPath);
      const parent = parentWatcherDir(relPath);
      if (parent !== null) {
        extraDirty.push(parent);
      }
    } else if (presence.isDirectory) {
      extraDirty.push(relPath);
    }
  }
  return { keepExact, extraDirty };
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
