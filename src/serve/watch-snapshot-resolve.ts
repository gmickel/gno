/**
 * Untrusted watcher hint → dirty directory resolution.
 *
 * @module src/serve/watch-snapshot-resolve
 */

// node:path — Bun has no path utilities
import { join, resolve, sep } from "node:path";

import type { WatcherSnapshotOptions } from "./watch-snapshot-types";

import { defaultFs } from "./watch-snapshot-scan";
import {
  isMissingFsError,
  normalizeWatcherRelPath,
  parentWatcherDir,
} from "./watch-snapshot-types";

/**
 * Resolve an untrusted hint to the dirty directory that should be diffed.
 * Missing paths climb to the nearest surviving in-root ancestor.
 *
 * A missing collection root is not a deletion proof: returns scan_failed
 * fallback so callers do not emit removal candidates or advance snapshots.
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

  // Root itself is missing — fail closed; never treat as a proven empty tree.
  return {
    status: "fallback",
    reason: "scan_failed",
    cause: new Error("Collection root is missing"),
  };
}
