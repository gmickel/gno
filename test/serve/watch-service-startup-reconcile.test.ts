/**
 * fn-205: `reconcileOnStart` queues one full reconcile per watched collection
 * through the normal flush path, so it inherits the failure backoff instead of
 * adding a hot loop on a collection that keeps failing.
 */

import { afterEach, expect, test } from "bun:test";
// node:fs/promises — test fixture setup
import { mkdtemp, writeFile } from "node:fs/promises";
// node:os — tmpdir
import { tmpdir } from "node:os";
// node:path — Bun has no path utilities
import { join } from "node:path";

import type { Collection } from "../../src/config/types";
import type { CollectionSyncResult } from "../../src/ingestion";
import type { SqliteAdapter } from "../../src/store/sqlite/adapter";

import { defaultSyncService } from "../../src/ingestion";
import { CollectionWatchService } from "../../src/serve/watch-service";
import { safeRm } from "../helpers/cleanup";
import { portableWatchOptions } from "./helpers/watch-portable-fixtures";

const originalSyncPaths = defaultSyncService.syncPaths.bind(defaultSyncService);
const originalSyncCollection =
  defaultSyncService.syncCollection.bind(defaultSyncService);
const roots: string[] = [];
const services: CollectionWatchService[] = [];

afterEach(async () => {
  defaultSyncService.syncCollection = originalSyncCollection;
  defaultSyncService.syncPaths = originalSyncPaths;
  for (const service of services.splice(0)) await service.dispose();
  for (const root of roots.splice(0)) await safeRm(root);
});

function syncResult(
  overrides: Partial<CollectionSyncResult> = {}
): CollectionSyncResult {
  return {
    collection: "notes",
    filesProcessed: 1,
    filesAdded: 0,
    filesUpdated: 0,
    filesUnchanged: 1,
    filesErrored: 0,
    filesSkipped: 0,
    filesMarkedInactive: 0,
    durationMs: 1,
    errors: [],
    ...overrides,
  };
}

async function collection(name: string): Promise<Collection> {
  const root = await mkdtemp(join(tmpdir(), `gno-watch-start-${name}-`));
  roots.push(root);
  await writeFile(join(root, "note.md"), "x");
  return { name, path: root, pattern: "**/*.md", include: [], exclude: [] };
}

function startService(
  collections: Collection[],
  syncCollection: (name: string) => Promise<CollectionSyncResult>,
  overrides: Partial<
    ConstructorParameters<typeof CollectionWatchService>[0]
  > = {}
): CollectionWatchService {
  defaultSyncService.syncCollection = (async (target: Collection) =>
    await syncCollection(
      target.name
    )) as unknown as typeof defaultSyncService.syncCollection;
  const service = new CollectionWatchService({
    ...portableWatchOptions(),
    collections,
    eventBus: null,
    scheduler: null,
    store: {} as unknown as SqliteAdapter,
    flushDebounceMs: 20,
    maxFlushDelayMs: 100,
    watchFactory: (() => ({ close: () => undefined })) as never,
    ...overrides,
  });
  services.push(service);
  service.start();
  return service;
}

test("each watched collection gets one full reconcile at start", async () => {
  const synced: string[] = [];
  const service = startService(
    [await collection("alpha"), await collection("beta")],
    async (name) => {
      synced.push(name);
      return syncResult({ collection: name });
    },
    { reconcileOnStart: true }
  );
  await Bun.sleep(400);
  expect(synced.sort()).toEqual(["alpha", "beta"]);
  expect(service.getState().queuedCollections).toEqual([]);
});

test("without reconcileOnStart the watcher only takes a baseline", async () => {
  const synced: string[] = [];
  startService([await collection("alpha")], async (name) => {
    synced.push(name);
    return syncResult({ collection: name });
  });
  await Bun.sleep(400);
  expect(synced).toEqual([]);
});

function failingFile(errorCode: string) {
  return syncResult({
    filesErrored: 1,
    filesUnchanged: 0,
    files: [{ relPath: "note.md", status: "error", errorCode }],
  });
}

function recordRetries(errorCode: string): string[][] {
  const retried: string[][] = [];
  defaultSyncService.syncPaths = (async (
    _collection: unknown,
    _store: unknown,
    paths: string[]
  ) => {
    retried.push(paths);
    return failingFile(errorCode);
  }) as unknown as typeof defaultSyncService.syncPaths;
  return retried;
}

// fn-211: a completed reconcile with one failing file used to requeue the
// whole collection with backoff, re-walking it every 5 minutes forever.
test("a file that keeps failing on its content is recorded once, never re-walked", async () => {
  let fullReconciles = 0;
  const retried = recordRetries("PERMISSION");
  const service = startService(
    [await collection("alpha")],
    async () => {
      fullReconciles += 1;
      return failingFile("PERMISSION");
    },
    { reconcileOnStart: true }
  );
  await Bun.sleep(2_700);
  expect(fullReconciles).toBe(1);
  expect(retried).toEqual([]);
  expect(service.getState().queuedCollections).toEqual([]);
});

test("a walker-only failure (in errors, not file receipts) is recorded once", async () => {
  let fullReconciles = 0;
  const retried = recordRetries("TOO_LARGE");
  startService(
    [await collection("alpha")],
    async () => {
      fullReconciles += 1;
      return syncResult({
        filesErrored: 1,
        files: [{ relPath: "ok.md", status: "unchanged" }],
        errors: [{ relPath: "huge.md", code: "TOO_LARGE", message: "big" }],
      });
    },
    { reconcileOnStart: true }
  );
  await Bun.sleep(2_700);
  expect(fullReconciles).toBe(1);
  expect(retried).toEqual([]);
});

test("a collection-level store failure keeps the whole-collection retry", async () => {
  let fullReconciles = 0;
  recordRetries("PERMISSION");
  startService(
    [await collection("alpha")],
    async () => {
      fullReconciles += 1;
      return syncResult({
        filesErrored: 1,
        filesUnchanged: 0,
        files: [
          { relPath: "note.md", status: "error", errorCode: "PERMISSION" },
        ],
        // e.g. the document inventory failed: deletions were not applied.
        errors: [{ relPath: "", code: "QUERY_FAILED", message: "inventory" }],
      });
    },
    { reconcileOnStart: true }
  );
  await Bun.sleep(2_700);
  expect(fullReconciles).toBeGreaterThanOrEqual(2);
});

test("a store-side failure retries only that path, with backoff", async () => {
  let fullReconciles = 0;
  const retried = recordRetries("QUERY_FAILED");
  startService(
    [await collection("alpha")],
    async () => {
      fullReconciles += 1;
      return failingFile("QUERY_FAILED");
    },
    { reconcileOnStart: true }
  );
  // Retries at ~+0.5 s and +1.5 s, then +3.5 s; a fixed 500 ms retry would
  // have made five or six attempts in this window.
  await Bun.sleep(2_700);
  expect(fullReconciles).toBe(1);
  expect(retried.length).toBeGreaterThanOrEqual(1);
  expect(retried.length).toBeLessThanOrEqual(3);
  expect(retried.every((paths) => paths.join() === "note.md")).toBe(true);
});

test("a collection that cannot be watched queues no startup work", async () => {
  const service = startService(
    [await collection("alpha")],
    async (name) => syncResult({ collection: name }),
    {
      reconcileOnStart: true,
      watchFactory: (() => {
        throw new Error("watch unavailable");
      }) as never,
    }
  );
  await Bun.sleep(200);
  const state = service.getState();
  expect(state.failedCollections.map(({ collection: name }) => name)).toEqual([
    "alpha",
  ]);
  expect(state.queuedCollections).toEqual([]);
});
