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

const originalSyncCollection =
  defaultSyncService.syncCollection.bind(defaultSyncService);
const roots: string[] = [];
const services: CollectionWatchService[] = [];

afterEach(async () => {
  defaultSyncService.syncCollection = originalSyncCollection;
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

test("a startup reconcile that keeps failing backs off", async () => {
  let calls = 0;
  startService(
    [await collection("alpha")],
    async () => {
      calls += 1;
      return syncResult({
        filesErrored: 1,
        filesUnchanged: 0,
        files: [{ relPath: "note.md", status: "error" }],
      });
    },
    { reconcileOnStart: true }
  );
  // Attempts at ~0, +0.5 s, +1.5 s, then +3.5 s. A fixed 500 ms retry would
  // have made five or six attempts in this window.
  await Bun.sleep(2_700);
  expect(calls).toBeGreaterThanOrEqual(2);
  expect(calls).toBeLessThanOrEqual(3);
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
