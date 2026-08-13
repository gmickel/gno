/**
 * Host review round-1 regressions for CollectionWatchService integration.
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

function createCollection(
  name: string,
  path: string,
  overrides: Partial<Collection> = {}
): Collection {
  return {
    name,
    path,
    pattern: "**/*.md",
    include: [],
    exclude: [],
    ...overrides,
  };
}

function createStubStore(
  overrides: Partial<SqliteAdapter> = {}
): SqliteAdapter {
  return {
    listActiveDirectChildSourcePaths: async () => ({ ok: true, value: [] }),
    listActiveDescendantSourcePaths: async () => ({ ok: true, value: [] }),
    listActiveSourcePaths: async () => ({ ok: true, value: [] }),
    ...overrides,
  } as unknown as SqliteAdapter;
}

function createSyncResult(
  overrides: Partial<CollectionSyncResult> = {}
): CollectionSyncResult {
  return {
    collection: "notes",
    filesProcessed: 0,
    filesAdded: 0,
    filesUpdated: 0,
    filesUnchanged: 0,
    filesErrored: 0,
    filesSkipped: 0,
    filesMarkedInactive: 0,
    durationMs: 1,
    errors: [],
    ...overrides,
  };
}

const originalSyncPaths = defaultSyncService.syncPaths.bind(defaultSyncService);
const originalSyncCollection =
  defaultSyncService.syncCollection.bind(defaultSyncService);

afterEach(() => {
  defaultSyncService.syncPaths = originalSyncPaths;
  defaultSyncService.syncCollection = originalSyncCollection;
});

describe("init absorption forceFallback", () => {
  test("temp event during init still content-hashes final path", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-init-temp-"));
    let watcherCallback:
      | ((eventType: string, filename: string | null) => void)
      | undefined;
    const seen: string[][] = [];
    try {
      // Final content present before baseline so absorption would hide changes.
      await writeFile(join(root, "doc.md"), "absorbed-final");
      // Pad tree slows baseline construction so the temp event lands during init.
      for (let i = 0; i < 80; i += 1) {
        await writeFile(join(root, `pad${i}.md`), `p${i}`);
      }
      defaultSyncService.syncPaths = (async (_c, _s, relPaths) => {
        seen.push(relPaths);
        return createSyncResult({
          filesProcessed: relPaths.length,
          filesUpdated: relPaths.length,
        });
      }) as typeof defaultSyncService.syncPaths;

      const service = new CollectionWatchService({
        collections: [createCollection("notes", root)],
        eventBus: null,
        scheduler: null,
        store: createStubStore(),
        flushDebounceMs: 30,
        maxFlushDelayMs: 250,
        watchFactory: ((
          _path: string,
          _options: { recursive: boolean },
          callback: WatchListener<string>
        ) => {
          watcherCallback = callback as typeof watcherCallback;
          return { close: () => undefined };
        }) as never,
      });
      service.start();
      // Fire before await so the dirty hint is queued while snapshot is not ready.
      watcherCallback?.("rename", "doc.md.tmp");
      await Bun.sleep(800);
      expect(seen.some((batch) => batch.includes("doc.md"))).toBe(true);
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });

  test("null filename during init still content-hashes present eligible finals", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-init-null-"));
    let watcherCallback:
      | ((eventType: string, filename: string | null) => void)
      | undefined;
    const seen: string[][] = [];
    try {
      await writeFile(join(root, "final.md"), "from-null-event");
      for (let i = 0; i < 80; i += 1) {
        await writeFile(join(root, `pad${i}.md`), `p${i}`);
      }
      defaultSyncService.syncPaths = (async (_c, _s, relPaths) => {
        seen.push(relPaths);
        return createSyncResult({
          filesProcessed: relPaths.length,
          filesUpdated: relPaths.length,
        });
      }) as typeof defaultSyncService.syncPaths;

      const service = new CollectionWatchService({
        collections: [createCollection("notes", root)],
        eventBus: null,
        scheduler: null,
        store: createStubStore(),
        flushDebounceMs: 30,
        maxFlushDelayMs: 250,
        watchFactory: ((
          _path: string,
          _options: { recursive: boolean },
          callback: WatchListener<string>
        ) => {
          watcherCallback = callback as typeof watcherCallback;
          return { close: () => undefined };
        }) as never,
      });
      service.start();
      watcherCallback?.("change", null);
      await Bun.sleep(800);
      expect(seen.some((batch) => batch.includes("final.md"))).toBe(true);
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });
});

describe("retry scheduling", () => {
  test("persistent failure keeps bounded call rate without overlap", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-retry-"));
    let watcherCallback:
      | ((eventType: string, filename: string) => void)
      | undefined;
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const callTimes: number[] = [];
    const startedAt = Date.now();
    try {
      await writeFile(join(root, "note.md"), "x");
      defaultSyncService.syncPaths = (async () => {
        calls += 1;
        callTimes.push(Date.now());
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Bun.sleep(40);
        inFlight -= 1;
        return createSyncResult({
          filesErrored: 1,
          files: [{ relPath: "note.md", status: "error", errorCode: "FAIL" }],
        });
      }) as typeof defaultSyncService.syncPaths;

      const service = new CollectionWatchService({
        collections: [createCollection("notes", root)],
        eventBus: null,
        scheduler: null,
        store: createStubStore(),
        flushDebounceMs: 20,
        maxFlushDelayMs: 100,
        watchFactory: ((
          _path: string,
          _options: { recursive: boolean },
          callback: WatchListener<string>
        ) => {
          watcherCallback = callback as typeof watcherCallback;
          return { close: () => undefined };
        }) as never,
      });
      service.start();
      await Bun.sleep(50);
      watcherCallback?.("change", "note.md");
      await Bun.sleep(1_600);
      expect(calls).toBeGreaterThanOrEqual(2);
      expect(calls).toBeLessThanOrEqual(5);
      expect(maxInFlight).toBe(1);
      // Successive attempts are spaced by retry backoff (~500ms), not immediate.
      if (callTimes.length >= 2) {
        const gap = (callTimes[1] ?? 0) - (callTimes[0] ?? 0);
        expect(gap).toBeGreaterThanOrEqual(400);
      }
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });
});

describe("generation full reconcile durability", () => {
  test("syncCollection returned file error leaves durable generation retry", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "gno-watch-gen-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "gno-watch-gen-b-"));
    const callbacks = new Map<
      string,
      (eventType: string, filename: string) => void
    >();
    let pathCalls = 0;
    let collectionCalls = 0;
    let finishFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    try {
      await writeFile(join(rootA, "old.md"), "o");
      await writeFile(join(rootB, "new.md"), "n");
      defaultSyncService.syncPaths = (async () => {
        pathCalls += 1;
        if (pathCalls === 1) {
          await firstGate;
        }
        return createSyncResult({
          filesProcessed: 1,
          filesUpdated: 1,
          files: [{ relPath: "old.md", status: "updated" }],
        });
      }) as typeof defaultSyncService.syncPaths;
      defaultSyncService.syncCollection = (async () => {
        collectionCalls += 1;
        if (collectionCalls === 1) {
          return createSyncResult({
            filesErrored: 1,
            files: [{ relPath: "new.md", status: "error", errorCode: "FAIL" }],
          });
        }
        return createSyncResult({
          filesProcessed: 1,
          filesAdded: 1,
          files: [{ relPath: "new.md", status: "added" }],
        });
      }) as typeof defaultSyncService.syncCollection;

      const service = new CollectionWatchService({
        collections: [createCollection("notes", rootA)],
        eventBus: null,
        scheduler: null,
        store: createStubStore(),
        flushDebounceMs: 30,
        maxFlushDelayMs: 200,
        watchFactory: ((
          path: string,
          _options: { recursive: boolean },
          callback: WatchListener<string>
        ) => {
          callbacks.set(
            path,
            callback as (eventType: string, filename: string) => void
          );
          return { close: () => undefined };
        }) as never,
      });
      service.start();
      await Bun.sleep(40);
      callbacks.get(rootA)?.("change", "old.md");
      await Bun.sleep(200);
      service.updateCollections([createCollection("notes", rootB)]);
      finishFirst?.();
      await Bun.sleep(1_200);
      expect(collectionCalls).toBeGreaterThanOrEqual(2);
      await service.dispose();
    } finally {
      await safeRm(rootA);
      await safeRm(rootB);
    }
  });

  test("syncCollection throw leaves durable generation retry", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "gno-watch-gen-throw-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "gno-watch-gen-throw-b-"));
    const callbacks = new Map<
      string,
      (eventType: string, filename: string) => void
    >();
    let pathCalls = 0;
    let collectionCalls = 0;
    let finishFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    try {
      await writeFile(join(rootA, "old.md"), "o");
      await writeFile(join(rootB, "new.md"), "n");
      defaultSyncService.syncPaths = (async () => {
        pathCalls += 1;
        if (pathCalls === 1) {
          await firstGate;
        }
        return createSyncResult({
          filesProcessed: 1,
          filesUpdated: 1,
        });
      }) as typeof defaultSyncService.syncPaths;
      defaultSyncService.syncCollection = (async () => {
        collectionCalls += 1;
        if (collectionCalls === 1) {
          throw new Error("generation boom");
        }
        return createSyncResult({
          filesProcessed: 1,
          filesAdded: 1,
        });
      }) as typeof defaultSyncService.syncCollection;

      const service = new CollectionWatchService({
        collections: [createCollection("notes", rootA)],
        eventBus: null,
        scheduler: null,
        store: createStubStore(),
        flushDebounceMs: 30,
        maxFlushDelayMs: 200,
        watchFactory: ((
          path: string,
          _options: { recursive: boolean },
          callback: WatchListener<string>
        ) => {
          callbacks.set(
            path,
            callback as (eventType: string, filename: string) => void
          );
          return { close: () => undefined };
        }) as never,
      });
      service.start();
      await Bun.sleep(40);
      callbacks.get(rootA)?.("change", "old.md");
      await Bun.sleep(200);
      service.updateCollections([createCollection("notes", rootB)]);
      finishFirst?.();
      await Bun.sleep(1_200);
      expect(collectionCalls).toBeGreaterThanOrEqual(2);
      await service.dispose();
    } finally {
      await safeRm(rootA);
      await safeRm(rootB);
    }
  });
});
