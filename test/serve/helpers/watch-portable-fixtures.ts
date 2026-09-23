/** Portable path-backed unit-test seam; never used for no-follow safety proofs. */
// node:fs — synchronous directory/stat fixture operations have no Bun equivalent.
import { lstatSync, readdirSync } from "node:fs";
// node:path — Bun has no path utilities.
import { join } from "node:path";

import type {
  WatcherSnapshotFs,
  WatcherSnapshotStat,
} from "../../../src/serve/watch-snapshot";

import { buildWatcherSnapshot } from "../../../src/serve/watch-snapshot";
import { fingerprintFromStat } from "../../../src/serve/watch-snapshot-types";
import { createRealPathBackedWatcherFs } from "./watch-snapshot-fixtures";

function fixtureStat(path: string): WatcherSnapshotStat {
  const stat = lstatSync(path, { bigint: true });
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
}

/** Stable fixture directories only: production requires pinned native handles. */
export function createPortableWatcherFs(): WatcherSnapshotFs {
  return {
    ...createRealPathBackedWatcherFs(),
    lstatChildByRelSync: (root, parent, name) =>
      fixtureStat(join(root, parent, name)),
    readDirectChildrenSync: (root, directory, limit) => {
      try {
        const path = join(root, directory);
        const names = readdirSync(path).sort();
        if (names.length > limit) return { status: "overflow" };
        const entries = new Map();
        for (const name of names) {
          const result = fingerprintFromStat(fixtureStat(join(path, name)));
          if (!result.ok) return { status: "unreliable_metadata" };
          entries.set(name, result.fingerprint);
        }
        return { status: "present", entries };
      } catch (cause) {
        return (cause as { code?: string }).code === "ENOENT"
          ? { status: "missing" }
          : { status: "scan_failed", cause };
      }
    },
  };
}

export function portableWatchOptions() {
  const fs = createPortableWatcherFs();
  return {
    snapshotFs: fs,
    buildSnapshot: (
      root: string,
      options?: Parameters<typeof buildWatcherSnapshot>[1]
    ) => buildWatcherSnapshot(root, { ...options, fs }),
  };
}
