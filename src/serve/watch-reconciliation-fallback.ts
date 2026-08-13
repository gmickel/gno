/**
 * Bounded store + disk fallback when snapshot classification cannot prove work.
 * Failed queries never imply inactivation.
 *
 * @module src/serve/watch-reconciliation-fallback
 */

// node:fs/promises — structure ops; no Bun equivalent for readdir/stat handles
import { readdir, stat } from "node:fs/promises";
// node:path — Bun has no path utilities
import { join, normalize } from "node:path";

import type { Collection } from "../config/types";
import type { SqliteAdapter } from "../store/sqlite/adapter";
import type { StoreResult } from "../store/types";

import { matchesCollectionExclusion } from "../core/path-rules";
import { collectionToWalkConfig, matchesWalkPath } from "../ingestion";
import {
  inspectPathPresence,
  type ClassificationResult,
} from "./watch-reconciliation-shared";
import { normalizeWatcherRelPath, parentWatcherDir } from "./watch-snapshot";

export async function fallbackClassifyDirtyHints(options: {
  collection: Collection;
  store: SqliteAdapter;
  rootAbs: string;
  dirtyHints: readonly string[];
  sourcePathMax: number;
}): Promise<ClassificationResult> {
  const { collection, store, rootAbs, dirtyHints, sourcePathMax } = options;
  const candidates = new Set<string>();
  const removals = new Set<string>();
  const walkConfig = collectionToWalkConfig(collection, 0);
  const diskSeen = new Set<string>();

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

  for (const dir of dirs) {
    if (dir !== "" && matchesCollectionExclusion(dir, walkConfig.exclude)) {
      continue;
    }

    const disk = await listEligibleDiskSources(
      rootAbs,
      dir,
      collection,
      sourcePathMax
    );
    if (disk.status === "error") {
      return { status: "error", cause: disk.cause, stage: "scan" };
    }
    if (disk.status === "overflow") {
      return {
        status: "error",
        cause: new Error(`Disk enumeration overflow under ${dir || "."}`),
        stage: "scan",
      };
    }
    for (const path of disk.paths) {
      candidates.add(path);
      diskSeen.add(path);
    }

    const storeChildren = await safeListDirect(
      store,
      collection.name,
      dir,
      sourcePathMax
    );
    if (!storeChildren.ok) {
      return {
        status: "error",
        cause: new Error(storeChildren.error.message),
        stage: "store",
      };
    }
    for (const path of storeChildren.value) {
      if (!matchesWalkPath(path, walkConfig)) {
        continue;
      }
      if (diskSeen.has(path)) {
        candidates.add(path);
      } else {
        removals.add(path);
      }
    }

    if (dir !== "") {
      const descendants = await safeListDescendants(
        store,
        collection.name,
        dir,
        sourcePathMax
      );
      if (!descendants.ok) {
        return {
          status: "error",
          cause: new Error(descendants.error.message),
          stage: "store",
        };
      }
      for (const path of descendants.value) {
        if (!matchesWalkPath(path, walkConfig)) {
          continue;
        }
        if (diskSeen.has(path)) {
          candidates.add(path);
        } else {
          removals.add(path);
        }
      }
    }
  }

  const provenRemovals: string[] = [];
  for (const path of removals) {
    const presence = await inspectPathPresence(rootAbs, path);
    if (presence.status === "missing") {
      provenRemovals.push(path);
    } else if (presence.status === "present") {
      candidates.add(path);
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
  collection: string,
  dir: string,
  max: number
): Promise<StoreResult<string[]>> {
  try {
    return await store.listActiveDescendantSourcePaths(collection, dir, max);
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

type DiskListResult =
  | { status: "ok"; paths: string[] }
  | { status: "overflow" }
  | { status: "error"; cause: unknown };

async function listEligibleDiskSources(
  rootAbs: string,
  dirRel: string,
  collection: Collection,
  max: number
): Promise<DiskListResult> {
  const walkConfig = collectionToWalkConfig(collection, 0);
  const root = normalize(rootAbs);
  const base =
    dirRel === ""
      ? root
      : normalize(join(root, ...dirRel.split("/").filter(Boolean)));

  let baseStat;
  try {
    baseStat = await stat(base);
  } catch (cause) {
    const code =
      cause && typeof cause === "object" && "code" in cause
        ? String(cause.code)
        : "";
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { status: "ok", paths: [] };
    }
    return { status: "error", cause };
  }
  if (!baseStat.isDirectory()) {
    return { status: "ok", paths: [] };
  }

  const paths: string[] = [];
  const queue: string[] = [dirRel];
  let head = 0;

  while (head < queue.length) {
    const current = queue[head] as string;
    head += 1;
    const abs =
      current === ""
        ? root
        : normalize(join(root, ...current.split("/").filter(Boolean)));
    let entries: Array<{ name: string; isFile: boolean; isDirectory: boolean }>;
    try {
      const dirents = await readdir(abs, { withFileTypes: true });
      entries = dirents.map((d) => ({
        name: d.name,
        isFile: d.isFile(),
        isDirectory: d.isDirectory(),
      }));
    } catch (cause) {
      const code =
        cause && typeof cause === "object" && "code" in cause
          ? String(cause.code)
          : "";
      if (code === "ENOENT" || code === "ENOTDIR") {
        continue;
      }
      return { status: "error", cause };
    }

    for (const entry of entries) {
      const childRel = current === "" ? entry.name : `${current}/${entry.name}`;
      if (matchesCollectionExclusion(childRel, walkConfig.exclude)) {
        continue;
      }
      if (entry.isDirectory) {
        queue.push(childRel);
        continue;
      }
      if (!entry.isFile) {
        continue;
      }
      if (!matchesWalkPath(childRel, walkConfig)) {
        continue;
      }
      paths.push(childRel);
      if (paths.length > max) {
        return { status: "overflow" };
      }
    }
  }

  return { status: "ok", paths };
}
