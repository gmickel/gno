/** Host review round-6: special exact path + dirty generation retention. */

import { describe, expect, test } from "bun:test";
// node:fs/promises — test fixture setup
import { mkdtemp, unlink, writeFile } from "node:fs/promises";
// node:os — tmpdir
import { tmpdir } from "node:os";
// node:path — Bun has no path utilities
import { join } from "node:path";

import { defaultSyncService } from "../../src/ingestion";
import { CollectionWatchService } from "../../src/serve/watch-service";
import { computeTargetedRetry } from "../../src/serve/watch-service-flush-helpers";
import { safeRm } from "../helpers/cleanup";
import {
  coll,
  createSyncResult,
  fakeWatch,
  installWatchServiceSyncReset,
  originalInactivate,
  statefulInactiveStore,
  stubStore,
  tryMkfifo,
} from "./helpers/watch-service-round6-fixtures";

installWatchServiceSyncReset();

describe("exact special path (lstat kind)", () => {
  test("file→FIFO: inactivates active source; special never NOT_FILE candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-r6-fifo-svc-"));
    let cb: ((e: string, f: string | null) => void) | undefined;
    const inactiveBatches: string[][] = [];
    const syncBatches: string[][] = [];
    try {
      await writeFile(join(root, "special.md"), "was-file");
      const serviceBoot = new CollectionWatchService({
        collections: [coll("notes", root)],
        eventBus: null,
        scheduler: null,
        store: stubStore(),
        flushDebounceMs: 20,
        maxFlushDelayMs: 100,
        watchFactory: fakeWatch(() => undefined),
      });
      serviceBoot.start();
      await Bun.sleep(180);
      await serviceBoot.dispose();

      await unlink(join(root, "special.md"));
      if (!(await tryMkfifo(join(root, "special.md")))) {
        return;
      }

      const { store, inactive } = statefulInactiveStore(["special.md"]);
      defaultSyncService.inactivateAbsentSources = (async (
        collection,
        _s,
        relPaths,
        options
      ) => {
        inactiveBatches.push([...relPaths]);
        return originalInactivate(collection, store, relPaths, options);
      }) as typeof defaultSyncService.inactivateAbsentSources;
      defaultSyncService.syncPaths = (async (_c, _s, relPaths) => {
        syncBatches.push([...relPaths]);
        // FIFO must not land in exact syncPaths (would NOT_FILE-loop).
        expect(relPaths).not.toContain("special.md");
        return createSyncResult({
          filesProcessed: relPaths.length,
          files: relPaths.map((relPath) => ({
            relPath,
            status: "unchanged" as const,
          })),
        });
      }) as typeof defaultSyncService.syncPaths;

      const service = new CollectionWatchService({
        collections: [coll("notes", root)],
        eventBus: null,
        scheduler: null,
        store,
        flushDebounceMs: 20,
        maxFlushDelayMs: 120,
        watchFactory: fakeWatch((c) => {
          cb = c;
        }),
      });
      service.start();
      await Bun.sleep(150);
      cb?.("rename", "special.md");
      await Bun.sleep(1_000);
      expect(inactiveBatches.some((b) => b.includes("special.md"))).toBe(true);
      expect(inactive).toContain("special.md");
      expect(syncBatches.every((b) => !b.includes("special.md"))).toBe(true);
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });
});

describe("dirty generation retention", () => {
  test("computeTargetedRetry retains dirty on candidate failure", () => {
    const result = createSyncResult({
      filesProcessed: 1,
      filesErrored: 1,
      files: [{ relPath: "new.md", status: "error", errorCode: "FAIL" }],
    });
    const retry = computeTargetedRetry({
      result,
      submittedPaths: ["new.md"],
      liveExact: [],
      settled: new Set(),
      dirtyHints: [""],
      dirtyFailed: false,
      dirtyDerivedSubmission: true,
      generationAuthority: false,
    });
    expect(retry.retainDirty).toBe(true);
    expect(retry.retryExact).toEqual(["new.md"]);
  });

  test("dirty candidate fails once then succeeds; later delete inactivates via snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-r6-dirty-ret-"));
    let cb: ((e: string, f: string | null) => void) | undefined;
    let pathCalls = 0;
    const pathBatches: string[][] = [];
    const inactiveBatches: string[][] = [];
    try {
      await writeFile(join(root, "seed.md"), "s");
      const { store, inactive, docs } = statefulInactiveStore(["seed.md"]);

      defaultSyncService.syncPaths = (async (_c, _s, relPaths) => {
        pathCalls += 1;
        pathBatches.push([...relPaths]);
        if (pathCalls === 1 && relPaths.includes("new.md")) {
          return createSyncResult({
            filesProcessed: relPaths.length,
            filesErrored: 1,
            files: relPaths.map((relPath) =>
              relPath === "new.md"
                ? {
                    relPath,
                    status: "error" as const,
                    errorCode: "FAIL",
                  }
                : { relPath, status: "unchanged" as const }
            ),
          });
        }
        for (const relPath of relPaths) {
          if (!docs.has(relPath)) {
            docs.set(relPath, {
              active: true,
              id: docs.size + 1,
              docid: `doc-${docs.size + 1}`,
            });
          } else {
            const row = docs.get(relPath);
            if (row) {
              row.active = true;
            }
          }
        }
        return createSyncResult({
          filesProcessed: relPaths.length,
          filesAdded: relPaths.includes("new.md") ? 1 : 0,
          files: relPaths.map((relPath) => ({
            relPath,
            status:
              relPath === "new.md"
                ? ("added" as const)
                : ("unchanged" as const),
          })),
        });
      }) as typeof defaultSyncService.syncPaths;

      defaultSyncService.inactivateAbsentSources = (async (
        collection,
        _s,
        relPaths,
        options
      ) => {
        inactiveBatches.push([...relPaths]);
        return originalInactivate(collection, store, relPaths, options);
      }) as typeof defaultSyncService.inactivateAbsentSources;

      const service = new CollectionWatchService({
        collections: [coll("notes", root)],
        eventBus: null,
        scheduler: null,
        store,
        flushDebounceMs: 25,
        maxFlushDelayMs: 150,
        watchFactory: fakeWatch((c) => {
          cb = c;
        }),
      });
      // Baseline with seed only, then add new.md so dirty discovers a candidate.
      service.start();
      await Bun.sleep(200);
      await writeFile(join(root, "new.md"), "n");
      // Ambiguous dirty discovers new.md; first sync fails, dirty retained.
      cb?.("rename", "new.md.tmp");
      await Bun.sleep(1_600);
      expect(pathCalls).toBeGreaterThanOrEqual(2);
      expect(pathBatches.some((b) => b.includes("new.md"))).toBe(true);
      expect(docs.get("new.md")?.active).toBe(true);

      // Delete after successful classified generation committed snapshot.
      await unlink(join(root, "new.md"));
      cb?.("rename", "new.md");
      await Bun.sleep(1_400);
      expect(inactiveBatches.some((b) => b.includes("new.md"))).toBe(true);
      expect(inactive).toContain("new.md");
      expect(service.getState().queuedCollections).toEqual([]);
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });

  test("removal partial failure retains dirty hints for retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-r6-rm-partial-"));
    let cb: ((e: string, f: string | null) => void) | undefined;
    let inactivateCalls = 0;
    try {
      await writeFile(join(root, "keep.md"), "k");
      await writeFile(join(root, "gone.md"), "g");
      const { store, inactive } = statefulInactiveStore(["keep.md", "gone.md"]);
      defaultSyncService.inactivateAbsentSources = (async (
        collection,
        _s,
        relPaths,
        options
      ) => {
        inactivateCalls += 1;
        if (inactivateCalls === 1 && relPaths.includes("gone.md")) {
          return createSyncResult({
            filesProcessed: 1,
            filesErrored: 1,
            files: [
              {
                relPath: "gone.md",
                status: "error",
                errorCode: "MARK_FAIL",
              },
            ],
          });
        }
        return originalInactivate(collection, store, relPaths, options);
      }) as typeof defaultSyncService.inactivateAbsentSources;
      // Present-path mock must not claim success for gone.md (removal is separate).
      defaultSyncService.syncPaths = (async (_c, _s, relPaths) =>
        createSyncResult({
          filesProcessed: relPaths.filter((p) => p !== "gone.md").length,
          filesUnchanged: relPaths.includes("keep.md") ? 1 : 0,
          files: relPaths
            .filter((p) => p !== "gone.md")
            .map((relPath) => ({
              relPath,
              status: "unchanged" as const,
            })),
        })) as typeof defaultSyncService.syncPaths;

      const service = new CollectionWatchService({
        collections: [coll("notes", root)],
        eventBus: null,
        scheduler: null,
        store,
        flushDebounceMs: 25,
        maxFlushDelayMs: 150,
        watchFactory: fakeWatch((c) => {
          cb = c;
        }),
      });
      // Baseline includes gone.md so later unlink is a proven snapshot removal.
      service.start();
      await Bun.sleep(200);
      await unlink(join(root, "gone.md"));
      cb?.("rename", "gone.md");
      await Bun.sleep(1_800);
      expect(inactivateCalls).toBeGreaterThanOrEqual(2);
      expect(inactive).toContain("gone.md");
      expect(service.getState().queuedCollections).toEqual([]);
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });
});
