/**
 * Bounded store + disk fallback when snapshot classification cannot prove work.
 * Failed queries never imply inactivation. Disk walks use no-follow handles.
 *
 * @module src/serve/watch-reconciliation-fallback
 */

// node:path — Bun has no path utilities
import { normalize } from "node:path";

import type { Collection } from "../config/types";
import type { SqliteAdapter } from "../store/sqlite/adapter";
import type { StoreResult } from "../store/types";

import { matchesCollectionExclusion } from "../core/path-rules";
import { collectionToWalkConfig, matchesWalkPath } from "../ingestion";
import {
  budgetExceeded,
  fallbackFs,
  inspectNoFollowPresence,
  listEligibleDiskSources,
  type FallbackBudget,
} from "./watch-reconciliation-fallback-disk";
import {
  WATCHER_FALLBACK_BUDGET,
  type ClassificationResult,
} from "./watch-reconciliation-shared";
import { openDirByRel } from "./watch-snapshot-scan";
import {
  normalizeWatcherRelPath,
  parentWatcherDir,
  type WatcherSnapshotFs,
} from "./watch-snapshot-types";

export async function fallbackClassifyDirtyHints(options: {
  collection: Collection;
  store: SqliteAdapter;
  rootAbs: string;
  dirtyHints: readonly string[];
  sourcePathMax: number;
  /** Test seam for unsupported-platform fail-closed proofs. */
  fs?: WatcherSnapshotFs;
}): Promise<ClassificationResult> {
  const { collection, store, rootAbs, dirtyHints } = options;
  const budgetLimit = Math.min(options.sourcePathMax, WATCHER_FALLBACK_BUDGET);
  const budget: FallbackBudget = {
    limit: budgetLimit,
    visitedDirs: 0,
    candidates: 0,
    removals: 0,
    dirtyDirs: 0,
    storeRows: 0,
  };
  const candidates = new Set<string>();
  const removals = new Set<string>();
  const walkConfig = collectionToWalkConfig(collection, 0);
  const diskSeen = new Set<string>();
  const fs = options.fs ?? fallbackFs();
  const root = normalize(rootAbs);

  // No anchored handles: never path-walk or infer deletions. Caller must use
  // durable full-collection reconciliation (syncCollection) instead.
  if (!fs.supportsAnchoredHandles) {
    return { status: "full_reconcile", reason: "unsupported_fs" };
  }

  const dirs = new Set<string>();
  for (const hint of dirtyHints) {
    const normalized =
      hint === "" ? "" : normalizeWatcherRelPath(hint.replaceAll("\\", "/"));
    if (normalized === null) {
      continue;
    }
    dirs.add(normalized);
    const parent = parentWatcherDir(normalized);
    if (parent !== null) {
      dirs.add(parent);
    }
  }

  // Prove collection root is available before any deletion comparison.
  const rootOpen = await openDirByRel(root, "", fs);
  if (rootOpen.status === "missing") {
    return {
      status: "error",
      cause: new Error("Collection root is missing"),
      stage: "scan",
    };
  }
  if (rootOpen.status !== "ok") {
    return {
      status: "error",
      cause:
        rootOpen.status === "scan_failed"
          ? rootOpen.cause
          : new Error("Collection root unavailable"),
      stage: "scan",
    };
  }
  await fs.closeDir(rootOpen.handle);

  for (const dir of dirs) {
    budget.dirtyDirs += 1;
    if (budgetExceeded(budget)) {
      return overflowResult(dir);
    }
    if (dir !== "" && matchesCollectionExclusion(dir, walkConfig.exclude)) {
      continue;
    }

    const disk = await listEligibleDiskSources(
      root,
      dir,
      collection,
      fs,
      budget
    );
    if (disk.status === "error") {
      return { status: "error", cause: disk.cause, stage: "scan" };
    }
    if (disk.status === "overflow") {
      return overflowResult(dir);
    }
    for (const path of disk.paths) {
      candidates.add(path);
      diskSeen.add(path);
      budget.candidates = candidates.size;
      if (budgetExceeded(budget)) {
        return overflowResult(dir);
      }
    }

    const storePaths = await collectStorePathsForDir(
      store,
      collection.name,
      dir,
      disk.rootDirNames,
      budget
    );
    if (!storePaths.ok) {
      return {
        status: "error",
        cause: new Error(storePaths.error.message),
        stage: "store",
      };
    }
    if (storePaths.overflow) {
      return overflowResult(dir);
    }
    for (const path of storePaths.value) {
      if (!matchesWalkPath(path, walkConfig)) {
        continue;
      }
      if (diskSeen.has(path)) {
        candidates.add(path);
        budget.candidates = candidates.size;
      } else {
        removals.add(path);
        budget.removals = removals.size;
      }
      if (budgetExceeded(budget)) {
        return overflowResult(dir);
      }
    }
  }

  const provenRemovals: string[] = [];
  for (const path of removals) {
    const presence = await inspectNoFollowPresence(root, path, fs);
    if (presence.status === "missing") {
      provenRemovals.push(path);
    } else if (presence.status === "present") {
      candidates.add(path);
    } else if (presence.status === "error") {
      return { status: "error", cause: presence.cause, stage: "scan" };
    }
  }

  return {
    status: "ok",
    candidates: [...candidates].sort(),
    removals: provenRemovals.sort(),
    nextSnapshot: null,
    usedFallback: true,
  };
}

function overflowResult(dir: string): ClassificationResult {
  return {
    status: "error",
    cause: new Error(`Fallback budget overflow under ${dir || "."}`),
    stage: "scan",
  };
}

async function collectStorePathsForDir(
  store: SqliteAdapter,
  collection: string,
  dir: string,
  rootDirNames: readonly string[],
  budget: FallbackBudget
): Promise<StoreResult<string[]> & { overflow?: boolean }> {
  const out = new Set<string>();

  const takeRows = (
    rows: string[]
  ): { ok: true } | { ok: false; overflow: true } => {
    for (const path of rows) {
      const before = out.size;
      out.add(path);
      if (out.size === before) {
        continue;
      }
      // Count unique store sources only (record-container logical dups collapse).
      budget.storeRows += 1;
      if (budgetExceeded(budget)) {
        return { ok: false, overflow: true };
      }
    }
    return { ok: true };
  };

  const remaining = (): number =>
    Math.max(1, budget.limit - budget.storeRows + 1);

  // Root: sole bounded DISTINCT inventory — never direct-child then root-wide
  // (that double-counted unique sources and falsely overflowed at scale).
  if (dir === "") {
    const inventory = await listRootActiveSourcePaths(
      store,
      collection,
      remaining()
    );
    if (inventory) {
      if (!inventory.ok) {
        return inventory;
      }
      if (inventory.overflow) {
        return { ok: true, value: [], overflow: true };
      }
      if (!takeRows(inventory.value).ok) {
        return { ok: true, value: [], overflow: true };
      }
      return { ok: true, value: [...out] };
    }

    // Seam unavailable (stubs): first-level disk-name probes only, no direct-child.
    const firstLevel = new Set<string>(rootDirNames);
    for (const name of firstLevel) {
      if (name === "" || name.includes("/")) {
        continue;
      }
      budget.dirtyDirs += 1;
      if (budgetExceeded(budget)) {
        return { ok: true, value: [], overflow: true };
      }
      const descendants = await safeListDescendants(
        store,
        collection,
        name,
        remaining()
      );
      if (!descendants.ok) {
        if (descendants.error.code === "OVERFLOW") {
          return { ok: true, value: [], overflow: true };
        }
        if (descendants.error.code === "INVALID_INPUT") {
          continue;
        }
        return descendants;
      }
      if (!takeRows(descendants.value).ok) {
        return { ok: true, value: [], overflow: true };
      }
    }
    return { ok: true, value: [...out] };
  }

  // Non-root: direct children + descendants under this directory.
  const direct = await safeListDirect(store, collection, dir, remaining());
  if (!direct.ok) {
    if (direct.error.code === "OVERFLOW") {
      return { ok: true, value: [], overflow: true };
    }
    return direct;
  }
  if (!takeRows(direct.value).ok) {
    return { ok: true, value: [], overflow: true };
  }

  const descendants = await safeListDescendants(
    store,
    collection,
    dir,
    remaining()
  );
  if (!descendants.ok) {
    if (descendants.error.code === "OVERFLOW") {
      return { ok: true, value: [], overflow: true };
    }
    return descendants;
  }
  if (!takeRows(descendants.value).ok) {
    return { ok: true, value: [], overflow: true };
  }
  return { ok: true, value: [...out] };
}

/**
 * Bounded root-wide DISTINCT active source inventory.
 * Returns null when the seam is unavailable (tests/stubs use disk probes).
 */
async function listRootActiveSourcePaths(
  store: SqliteAdapter,
  collection: string,
  max: number
): Promise<(StoreResult<string[]> & { overflow?: boolean }) | null> {
  if (typeof store.listActiveSourcePaths !== "function") {
    return null;
  }
  try {
    const result = await store.listActiveSourcePaths(collection, max);
    if (!result.ok) {
      if (result.error.code === "OVERFLOW") {
        return { ok: true, value: [], overflow: true };
      }
      return result;
    }
    return { ok: true, value: result.value };
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: "QUERY_FAILED",
        message:
          cause instanceof Error
            ? cause.message
            : "Root store inventory failed",
        cause,
      },
    };
  }
}

async function safeListDirect(
  store: SqliteAdapter,
  collection: string,
  dir: string,
  max: number
): Promise<StoreResult<string[]>> {
  try {
    return await store.listActiveDirectChildSourcePaths(collection, dir, max);
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: "QUERY_FAILED",
        message:
          cause instanceof Error
            ? cause.message
            : "Direct-child store query failed",
        cause,
      },
    };
  }
}

async function safeListDescendants(
  store: SqliteAdapter,
  storeCollection: string,
  dir: string,
  max: number
): Promise<StoreResult<string[]>> {
  try {
    return await store.listActiveDescendantSourcePaths(
      storeCollection,
      dir,
      max
    );
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: "QUERY_FAILED",
        message:
          cause instanceof Error
            ? cause.message
            : "Descendant store query failed",
        cause,
      },
    };
  }
}
