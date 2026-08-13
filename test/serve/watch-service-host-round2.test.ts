/**
 * Host review round-2 regressions: durable forceFallback, unsupported platform,
 * generation options freshness.
 */

import type { WatchListener } from "node:fs";

import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises — test fixture setup
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
// node:os — tmpdir
import { tmpdir } from "node:os";
// node:path — Bun has no path utilities
import { join } from "node:path";

import type { Collection } from "../../src/config/types";
import type { CollectionSyncResult } from "../../src/ingestion";
import type { SqliteAdapter } from "../../src/store/sqlite/adapter";

import { defaultSyncService } from "../../src/ingestion";
import { classifyDirtyHints } from "../../src/serve/watch-reconciliation";
import { CollectionWatchService } from "../../src/serve/watch-service";
import {
  applyPendingForceFlags,
  emptyPending,
  queueDirtyHint,
  takePending,
} from "../../src/serve/watch-service-state";
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

describe("durable forceFallback / overflow", () => {
  test("applyPendingForceFlags restores forceFallback and overflow root dirty", () => {
    const pending = emptyPending();
    queueDirtyHint(pending, "a.tmp", 100);
    const taken = takePending(pending);
    expect(taken.forceFallback).toBe(false);
    const restored = applyPendingForceFlags(emptyPending(), {
      forceFallback: true,
      overflow: true,
    });
    expect(restored.forceFallback).toBe(true);
    expect(restored.overflow).toBe(true);
    expect(restored.dirty.has("")).toBe(true);
    const retaken = takePending(restored);
    expect(retaken.forceFallback).toBe(true);
    expect(retaken.overflow).toBe(true);
    expect(retaken.dirty).toContain("");
  });

  test("init temp forceFallback survives first store failure then hashes final", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-ff-retry-"));
    let watcherCallback:
      | ((eventType: string, filename: string | null) => void)
      | undefined;
    const seen: string[][] = [];
    let storeCalls = 0;
    try {
      await writeFile(join(root, "doc.md"), "absorbed-final");
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
        store: createStubStore({
          listActiveDirectChildSourcePaths: async () => {
            storeCalls += 1;
            if (storeCalls === 1) {
              return {
                ok: false,
                error: { code: "QUERY_FAILED", message: "store boom" },
              };
            }
            return { ok: true, value: ["doc.md"] };
          },
          listActiveSourcePaths: async () => {
            storeCalls += 1;
            if (storeCalls <= 2) {
              return {
                ok: false,
                error: { code: "QUERY_FAILED", message: "store boom" },
              };
            }
            return { ok: true, value: ["doc.md"] };
          },
        }),
        flushDebounceMs: 20,
        maxFlushDelayMs: 150,
        buildSnapshot: async () => ({
          status: "fallback",
          reason: "scan_failed",
          durationMs: 0,
          cause: new Error("forced empty baseline"),
        }),
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
      watcherCallback?.("rename", "doc.md.tmp");
      await Bun.sleep(1_400);
      expect(seen.some((batch) => batch.includes("doc.md"))).toBe(true);
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });

  test("overflow root dirty cannot disappear across requeue flags", () => {
    const maxDirty = 8;
    let pending = emptyPending();
    for (let i = 0; i < maxDirty; i += 1) {
      pending = queueDirtyHint(pending, `tmp-${i}`, maxDirty);
    }
    pending = queueDirtyHint(pending, "extra", maxDirty);
    expect(pending.overflow).toBe(true);
    const taken = takePending(pending);
    expect(taken.overflow).toBe(true);
    expect(taken.forceFallback).toBe(true);
    expect(taken.dirty[0]).toBe("");
    const next = applyPendingForceFlags(emptyPending(), {
      forceFallback: taken.forceFallback,
      overflow: taken.overflow,
    });
    for (const hint of taken.dirty) {
      queueDirtyHint(next, hint, maxDirty);
    }
    expect(next.overflow).toBe(true);
    expect(next.forceFallback).toBe(true);
    expect(next.dirty.has("")).toBe(true);
    const retaken = takePending(next);
    expect(retaken.dirty).toContain("");
    expect(retaken.forceFallback).toBe(true);
  });

  test("pattern-directory child failure retries with forced discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-folder-retry-"));
    let watcherCallback:
      | ((eventType: string, filename: string) => void)
      | undefined;
    const seen: string[][] = [];
    let attempts = 0;
    try {
      await mkdir(join(root, "folder.md"), { recursive: true });
      await writeFile(join(root, "folder.md", "child.md"), "c");
      defaultSyncService.syncPaths = (async (_c, _s, relPaths) => {
        attempts += 1;
        seen.push(relPaths);
        if (attempts === 1) {
          return createSyncResult({
            filesErrored: 1,
            files: [
              {
                relPath: "folder.md/child.md",
                status: "error",
                errorCode: "FAIL",
              },
            ],
          });
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
      await Bun.sleep(80);
      watcherCallback?.("change", "folder.md");
      await Bun.sleep(1_400);
      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(seen.some((batch) => batch.includes("folder.md/child.md"))).toBe(
        true
      );
      expect(seen.every((batch) => !batch.includes("folder.md"))).toBe(true);
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });
});

describe("unsupported platform fail-closed", () => {
  test("missing root does not escalate to a destructive full reconcile", async () => {
    const root = join(tmpdir(), `gno-watch-missing-${crypto.randomUUID()}`);
    const classified = await classifyDirtyHints({
      collection: createCollection("notes", root),
      store: createStubStore(),
      rootAbs: root,
      previous: null,
      dirtyHints: [""],
      snapshotOptions: {
        fs: {
          supportsAnchoredHandles: false,
          openDir: async () => {
            throw new Error("should not path-walk");
          },
          readDir: async () => ({ status: "ok", names: [] }),
          lstatChild: async () => {
            throw new Error("should not path-walk");
          },
          openChildDir: async () => {
            throw new Error("should not path-walk");
          },
          closeDir: async () => undefined,
        },
      },
    });

    expect(classified.status).toBe("error");
    if (classified.status === "error") {
      expect(classified.stage).toBe("scan");
    }
  });

  test("unsupported fs never path-walks or infers deletions", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-unsup-"));
    const pathOps: string[] = [];
    try {
      await writeFile(join(root, "keep.md"), "k");
      const classified = await classifyDirtyHints({
        collection: createCollection("notes", root),
        store: createStubStore({
          listActiveSourcePaths: async () => ({
            ok: true,
            value: ["keep.md", "gone.md"],
          }),
          listActiveDirectChildSourcePaths: async () => ({
            ok: true,
            value: ["keep.md", "gone.md"],
          }),
        }),
        rootAbs: root,
        previous: null,
        dirtyHints: [""],
        snapshotOptions: {
          fs: {
            supportsAnchoredHandles: false,
            openDir: async (abs) => {
              pathOps.push(`open:${abs}`);
              throw Object.assign(new Error("ENOTSUP"), { code: "ENOTSUP" });
            },
            readDir: async () => {
              pathOps.push("readDir");
              return { status: "ok", names: ["keep.md"] };
            },
            lstatChild: async (_h, name) => {
              pathOps.push(`lstat:${name}`);
              throw new Error("should not run");
            },
            openChildDir: async (_h, name) => {
              pathOps.push(`openChild:${name}`);
              throw new Error("should not run");
            },
            closeDir: async () => undefined,
          },
        },
      });
      // Unsupported FS must not path-walk; full_reconcile is the durable path.
      expect(classified.status).toBe("full_reconcile");
      if (classified.status === "full_reconcile") {
        expect(classified.reason).toBe("unsupported_fs");
      }
      expect(pathOps).toEqual([]);
    } finally {
      await safeRm(root);
    }
  });

  test("openDirByRel refuses path-based walks when handles unsupported", async () => {
    const { openDirByRel } =
      await import("../../src/serve/watch-snapshot-scan");
    const pathOps: string[] = [];
    const fs = {
      supportsAnchoredHandles: false as const,
      openDir: async (abs: string) => {
        pathOps.push(`open:${abs}`);
        throw new Error("should not open path");
      },
      readDir: async () => {
        pathOps.push("readDir");
        return { status: "ok" as const, names: [] };
      },
      lstatChild: async () => {
        pathOps.push("lstat");
        throw new Error("no");
      },
      openChildDir: async () => {
        pathOps.push("openChild");
        throw new Error("no");
      },
      closeDir: async () => undefined,
    };
    const result = await openDirByRel("/tmp/any", "", fs);
    expect(result.status).toBe("scan_failed");
    expect(pathOps).toEqual([]);
  });
});

describe("generation options freshness", () => {
  test("blocked syncPaths then updateCollections passes new options to syncCollection", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "gno-watch-opt-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "gno-watch-opt-b-"));
    const callbacks = new Map<
      string,
      (eventType: string, filename: string) => void
    >();
    let finishFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const seenOptions: Array<string | undefined> = [];
    try {
      await writeFile(join(rootA, "old.md"), "o");
      await writeFile(join(rootB, "new.md"), "n");
      defaultSyncService.syncPaths = (async () => {
        await firstGate;
        return createSyncResult({
          filesProcessed: 1,
          filesUpdated: 1,
          files: [{ relPath: "old.md", status: "updated" }],
        });
      }) as typeof defaultSyncService.syncPaths;
      defaultSyncService.syncCollection = (async (_c, _s, options) => {
        seenOptions.push(options?.contentTypeRulesFingerprint);
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
        syncOptions: { contentTypeRulesFingerprint: "before" },
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
      service.updateCollections([createCollection("notes", rootB)], {
        contentTypeRulesFingerprint: "after",
      });
      finishFirst?.();
      await Bun.sleep(800);
      expect(seenOptions.length).toBeGreaterThanOrEqual(1);
      expect(seenOptions.every((fp) => fp === "after")).toBe(true);
      await service.dispose();
    } finally {
      await safeRm(rootA);
      await safeRm(rootB);
    }
  });
});
