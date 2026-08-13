/**
 * Shared fixtures for watcher snapshot tests (gno-27).
 */

import { mkdir, readdir, writeFile } from "node:fs/promises";
// node:path — Bun has no path utilities
import { join } from "node:path";

import type {
  SnapshotEntryFingerprint,
  WatcherSnapshotFs,
  WatcherSnapshotStat,
} from "../../../src/serve/watch-snapshot";

import { createPathBackedWatcherFs } from "../../../src/serve/watch-snapshot";

export async function writeWatchFixture(
  root: string,
  rel: string,
  body = "x"
): Promise<void> {
  const abs = join(root, ...rel.split("/"));
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, body);
}

export function snapshotFingerprint(
  kind: SnapshotEntryFingerprint["kind"],
  inode: bigint
): SnapshotEntryFingerprint {
  return {
    kind,
    device: 1n,
    inode,
    size: 1,
    mtimeNs: 1_000n,
    ctimeNs: 1_000n,
  };
}

export async function realLstatAsWatcherStat(
  absPath: string
): Promise<WatcherSnapshotStat> {
  const { lstat } = await import("node:fs/promises");
  const stat = await lstat(absPath, { bigint: true });
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

/** Path-backed adapter over the real node:fs (test-only; not production-safe). */
export function createRealPathBackedWatcherFs(
  lstatOverride?: (absPath: string) => Promise<WatcherSnapshotStat>
): WatcherSnapshotFs {
  return createPathBackedWatcherFs({
    readdir: async (absPath: string) => readdir(absPath),
    lstat: lstatOverride ?? realLstatAsWatcherStat,
  });
}
