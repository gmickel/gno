/**
 * CollectionWatchService integration tests for exact/ambiguous reconciliation.
 */

import type { WatchListener } from "node:fs";

import { describe, expect, mock, test } from "bun:test";
// node:fs/promises — test fixture setup
import { mkdtemp, writeFile } from "node:fs/promises";
// node:os — tmpdir
import { tmpdir } from "node:os";
// node:path — Bun has no path utilities
import { join } from "node:path";

import { defaultSyncService } from "../../src/ingestion";
import { CollectionWatchService } from "../../src/serve/watch-service";
import { safeRm } from "../helpers/cleanup";
import {
  createCollection,
  createStubStore,
  createSyncResult,
  installWatchServiceSyncReset,
} from "./helpers/watch-service-fixtures";

installWatchServiceSyncReset();

describe("CollectionWatchService reconciliation integration", () => {
  test("exact eligible event always reaches syncPaths", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-exact-"));
    let watcherCallback:
      | ((eventType: string, filename: string) => void)
      | undefined;
    const seen: string[][] = [];
    try {
      await writeFile(join(root, "note.md"), "same-size-body");
      defaultSyncService.syncPaths = (async (_c, _s, relPaths) => {
        seen.push(relPaths);
        return createSyncResult({
          filesProcessed: relPaths.length,
          filesUpdated: relPaths.length,
          files: relPaths.map((relPath) => ({ relPath, status: "updated" })),
        });
      }) as typeof defaultSyncService.syncPaths;

      const service = new CollectionWatchService({
        collections: [createCollection("notes", root)],
        eventBus: null,
        scheduler: null,
        store: createStubStore(),
        flushDebounceMs: 50,
        maxFlushDelayMs: 200,
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
      await Bun.sleep(80);
      await writeFile(join(root, "note.md"), "same-size-body");
      watcherCallback?.("change", "note.md");
      await Bun.sleep(300);
      expect(seen.some((batch) => batch.includes("note.md"))).toBe(true);
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });

  test("atomic temp replacement via dirty hint discovers final path", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-atomic-"));
    let watcherCallback:
      | ((eventType: string, filename: string) => void)
      | undefined;
    const seen: string[][] = [];
    try {
      await writeFile(join(root, "doc.md"), "v1");
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
        flushDebounceMs: 40,
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
      await Bun.sleep(100);
      await writeFile(join(root, "doc.md.tmp"), "v2");
      await writeFile(join(root, "doc.md"), "v2");
      await safeRm(join(root, "doc.md.tmp")).catch(() => undefined);
      watcherCallback?.("rename", "doc.md.tmp");
      await Bun.sleep(350);
      expect(seen.some((batch) => batch.includes("doc.md"))).toBe(true);
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });

  test("invalid and excluded paths never reach syncPaths", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-invalid-"));
    let watcherCallback:
      | ((eventType: string, filename: string) => void)
      | undefined;
    const syncPaths = mock(async () => createSyncResult());
    defaultSyncService.syncPaths =
      syncPaths as typeof defaultSyncService.syncPaths;
    try {
      const collection = createCollection("notes", root, {
        exclude: ["private"],
      });
      const service = new CollectionWatchService({
        collections: [collection],
        eventBus: null,
        scheduler: null,
        store: createStubStore(),
        flushDebounceMs: 30,
        maxFlushDelayMs: 150,
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
      watcherCallback?.("change", "../escape.md");
      watcherCallback?.("change", "/abs.md");
      watcherCallback?.("change", "private/secret.md");
      await Bun.sleep(250);
      expect(syncPaths).not.toHaveBeenCalled();
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });

  test("suppression drops exact path events within the window", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-supp-"));
    let watcherCallback:
      | ((eventType: string, filename: string) => void)
      | undefined;
    const syncPaths = mock(async () => createSyncResult());
    defaultSyncService.syncPaths =
      syncPaths as typeof defaultSyncService.syncPaths;
    try {
      await writeFile(join(root, "note.md"), "x");
      const service = new CollectionWatchService({
        collections: [createCollection("notes", root)],
        eventBus: null,
        scheduler: null,
        store: createStubStore(),
        flushDebounceMs: 30,
        maxFlushDelayMs: 150,
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
      service.suppress(join(root, "note.md"), 5_000);
      watcherCallback?.("change", "note.md");
      await Bun.sleep(250);
      expect(syncPaths).not.toHaveBeenCalled();
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });

  test("sustained unique-temp churn flushes within hard deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-churn-"));
    let watcherCallback:
      | ((eventType: string, filename: string) => void)
      | undefined;
    let firstFlushAt: number | null = null;
    const startedAt = Date.now();
    try {
      await writeFile(join(root, "keep.md"), "k");
      defaultSyncService.syncPaths = (async (_c, _s, relPaths) => {
        if (firstFlushAt === null) {
          firstFlushAt = Date.now();
        }
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
        flushDebounceMs: 200,
        maxFlushDelayMs: 400,
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
      await Bun.sleep(60);
      watcherCallback?.("change", "keep.md");
      for (let i = 0; i < 12; i += 1) {
        watcherCallback?.("rename", `tmp-${i}-${Date.now()}.part`);
        await Bun.sleep(80);
      }
      await Bun.sleep(500);
      expect(firstFlushAt).not.toBeNull();
      expect((firstFlushAt ?? 0) - startedAt).toBeLessThan(1_200);
      expect(service.getState().queuedCollections).toEqual([]);
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });

  test("events during snapshot init are buffered and flushed later", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-init-"));
    let watcherCallback:
      | ((eventType: string, filename: string) => void)
      | undefined;
    const seen: string[][] = [];
    try {
      for (let i = 0; i < 40; i += 1) {
        await writeFile(join(root, `f${i}.md`), `c${i}`);
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
        flushDebounceMs: 40,
        maxFlushDelayMs: 300,
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
      watcherCallback?.("change", "f0.md");
      await Bun.sleep(400);
      expect(seen.some((batch) => batch.includes("f0.md"))).toBe(true);
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });

  test("sync path file errors requeue work and skip snapshot commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-syncfail-"));
    let watcherCallback:
      | ((eventType: string, filename: string) => void)
      | undefined;
    const onSyncError = mock(() => undefined);
    let calls = 0;
    try {
      await writeFile(join(root, "note.md"), "x");
      defaultSyncService.syncPaths = (async (_c, _s, relPaths) => {
        calls += 1;
        if (calls === 1) {
          return createSyncResult({
            filesErrored: 1,
            files: [
              {
                relPath: relPaths[0] ?? "note.md",
                status: "error",
                errorCode: "FAIL",
              },
            ],
          });
        }
        return createSyncResult({
          filesProcessed: 1,
          filesUpdated: 1,
          files: [{ relPath: "note.md", status: "updated" }],
        });
      }) as typeof defaultSyncService.syncPaths;

      const service = new CollectionWatchService({
        collections: [createCollection("notes", root)],
        eventBus: null,
        scheduler: null,
        store: createStubStore(),
        callbacks: { onSyncError },
        flushDebounceMs: 30,
        maxFlushDelayMs: 200,
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
      await Bun.sleep(900);
      expect(onSyncError).toHaveBeenCalled();
      expect(calls).toBeGreaterThanOrEqual(2);
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });

  test("root replacement clears pending and snapshot atomically", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "gno-watch-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "gno-watch-b-"));
    const callbacks = new Map<
      string,
      (eventType: string, filename: string) => void
    >();
    const seen: string[][] = [];
    try {
      await writeFile(join(rootA, "old.md"), "o");
      await writeFile(join(rootB, "new.md"), "n");
      defaultSyncService.syncPaths = (async (_c, _s, relPaths) => {
        seen.push(relPaths);
        return createSyncResult({
          filesProcessed: relPaths.length,
          filesUpdated: relPaths.length,
        });
      }) as typeof defaultSyncService.syncPaths;
      // Root replacement durably enqueues generation reconcile.
      defaultSyncService.syncCollection = (async () =>
        createSyncResult({
          filesProcessed: 1,
          filesAdded: 1,
          files: [{ relPath: "new.md", status: "added" }],
        })) as typeof defaultSyncService.syncCollection;

      const service = new CollectionWatchService({
        collections: [createCollection("notes", rootA)],
        eventBus: null,
        scheduler: null,
        store: createStubStore(),
        flushDebounceMs: 200,
        maxFlushDelayMs: 1_000,
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
      service.updateCollections([createCollection("notes", rootB)]);
      await Bun.sleep(500);
      expect(seen.every((batch) => !batch.includes("old.md"))).toBe(true);
      callbacks.get(rootB)?.("change", "new.md");
      await Bun.sleep(700);
      expect(seen.some((batch) => batch.includes("new.md"))).toBe(true);
      await service.dispose();
    } finally {
      await safeRm(rootA);
      await safeRm(rootB);
    }
  });

  test("record-container eligible path still reaches targeted sync", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-record-"));
    let watcherCallback:
      | ((eventType: string, filename: string) => void)
      | undefined;
    const seen: string[][] = [];
    try {
      await writeFile(join(root, "chat.jsonl"), '{"x":1}\n');
      defaultSyncService.syncPaths = (async (_c, _s, relPaths) => {
        seen.push(relPaths);
        return createSyncResult({
          filesProcessed: relPaths.length,
          filesUpdated: relPaths.length,
        });
      }) as typeof defaultSyncService.syncPaths;

      const collection = createCollection("notes", root, {
        pattern: "**/*.{md,jsonl}",
        recordAdapters: {
          jsonl: {},
        },
      });
      const service = new CollectionWatchService({
        collections: [collection],
        eventBus: null,
        scheduler: null,
        store: createStubStore(),
        flushDebounceMs: 40,
        maxFlushDelayMs: 200,
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
      await Bun.sleep(60);
      watcherCallback?.("change", "chat.jsonl");
      await Bun.sleep(300);
      expect(seen.some((batch) => batch.includes("chat.jsonl"))).toBe(true);
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });
});
