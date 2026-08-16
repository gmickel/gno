/**
 * Source-availability boundaries shared by watcher snapshot operations.
 *
 * @module src/serve/watch-snapshot-availability
 */

// node:path — Bun has no path join helper.
import { join } from "node:path";

import type { WatcherSnapshotFs } from "./watch-snapshot-types";

import {
  isUnprovenDirectoryResult,
  type DirectoryAvailabilityPort,
} from "../ingestion/source-availability";
import { readDirectChildren } from "./watch-snapshot-scan";

export async function directoryAllowsDescent(
  rootAbs: string,
  dirRel: string,
  classifier: DirectoryAvailabilityPort | undefined
): Promise<boolean> {
  if (!classifier || classifier.mode === "any") {
    return true;
  }
  const absPath = dirRel === "" ? rootAbs : join(rootAbs, dirRel);
  const classified = await classifier.classify(absPath);
  return !isUnprovenDirectoryResult(classified);
}

export async function readAvailableDirectory(
  rootAbs: string,
  dirRel: string,
  fs: WatcherSnapshotFs,
  maxEntries: number,
  classifier: DirectoryAvailabilityPort | undefined
): Promise<
  Awaited<ReturnType<typeof readDirectChildren>> | { status: "unproven" }
> {
  if (!classifier || classifier.mode === "any") {
    return readDirectChildren(rootAbs, dirRel, fs, maxEntries);
  }
  if (!fs.readDirectChildrenSync) {
    return { status: "unproven" };
  }
  const absPath = dirRel === "" ? rootAbs : join(rootAbs, dirRel);
  const read = classifier.readDirectory(absPath, () =>
    fs.readDirectChildrenSync!(rootAbs, dirRel, maxEntries)
  );
  return read.kind === "available" ? read.value : { status: "unproven" };
}
