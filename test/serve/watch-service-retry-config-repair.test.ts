/**
 * fn-202: a live config repair is user action, so it must not wait out a
 * failure backoff armed by the broken config, and it restarts the count.
 */

import type { WatchListener } from "node:fs";

import { afterEach, describe, expect, test } from "bun:test";
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

afterEach(() => {
  defaultSyncService.syncPaths = originalSyncPaths;
  defaultSyncService.syncCollection = originalSyncCollection;
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

const failed = (): CollectionSyncResult =>
  syncResult({
    filesErrored: 1,
    filesUnchanged: 0,
    files: [
      {
        relPath: "note.md",
        status: "error",
        errorCode: "SOURCE_AVAILABILITY_UNSUPPORTED",
      },
    ],
  });

async function watchFailingNote(repairFixesSync: boolean) {
  const root = await mkdtemp(join(tmpdir(), "gno-watch-config-repair-"));
  await writeFile(join(root, "note.md"), "x");
  let repaired = false;
  let attemptsAfterRepair = 0;
  defaultSyncService.syncPaths = (async () => {
    if (!repaired) {
      return failed();
    }
    attemptsAfterRepair += 1;
    return repairFixesSync ? syncResult() : failed();
  }) as unknown as typeof defaultSyncService.syncPaths;
  defaultSyncService.syncCollection = (async () =>
    syncResult({
      files: [],
    })) as unknown as typeof defaultSyncService.syncCollection;
  const collection: Collection = {
    name: "notes",
    path: root,
    pattern: "**/*.md",
    include: [],
    exclude: [],
  };
  let emit: ((eventType: string, filename: string | null) => void) | undefined;
  const service = new CollectionWatchService({
    ...portableWatchOptions(),
    collections: [collection],
    eventBus: null,
    scheduler: null,
    store: {
      listActiveDirectChildSourcePaths: async () => ({ ok: true, value: [] }),
      listActiveDescendantSourcePaths: async () => ({ ok: true, value: [] }),
      listActiveSourcePaths: async () => ({ ok: true, value: [] }),
    } as unknown as SqliteAdapter,
    flushDebounceMs: 20,
    maxFlushDelayMs: 100,
    watchFactory: ((
      _path: string,
      _options: { recursive: boolean },
      callback: WatchListener<string>
    ) => {
      emit = callback as typeof emit;
      return { close: () => undefined };
    }) as never,
  });
  service.start();
  await Bun.sleep(60);
  return {
    touch: () => emit?.("change", "note.md"),
    attemptsAfterRepair: () => attemptsAfterRepair,
    repairConfig: () => {
      // Same root, materially different config: a new watcher generation.
      repaired = true;
      service.updateCollections([{ ...collection, exclude: ["drafts/**"] }]);
    },
    cleanup: async () => {
      await service.dispose();
      await safeRm(root);
    },
  };
}

describe("watcher config repair during a failure backoff", () => {
  test("a config repair flushes without waiting for the armed retry", async () => {
    const watch = await watchFailingNote(true);
    try {
      watch.touch();
      // Failures at ~0, +0.5 s, +1.5 s; the next retry is not due until +3.5 s.
      await Bun.sleep(1_800);
      watch.repairConfig();
      await Bun.sleep(400);
      expect(watch.attemptsAfterRepair()).toBe(1);
    } finally {
      await watch.cleanup();
    }
  });

  test("a config repair restarts the failure count", async () => {
    const watch = await watchFailingNote(false);
    try {
      watch.touch();
      await Bun.sleep(1_800);
      watch.repairConfig();
      // A repair that did not fix the cause retries 500 ms after its first
      // failure, not after the 4 s a fourth consecutive failure would earn.
      await Bun.sleep(900);
      expect(watch.attemptsAfterRepair()).toBe(2);
    } finally {
      await watch.cleanup();
    }
  });
});
