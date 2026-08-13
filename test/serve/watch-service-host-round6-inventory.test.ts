/** Host review round-6: full-sync inventory / inactivation errors. */

import { describe, expect, test } from "bun:test";
// node:fs/promises — test fixture setup
import { mkdtemp, writeFile } from "node:fs/promises";
// node:os — tmpdir
import { tmpdir } from "node:os";
// node:path — Bun has no path utilities
import { join } from "node:path";

import type { SqliteAdapter } from "../../src/store/sqlite/adapter";
import type { DocumentRow } from "../../src/store/types";

import { defaultSyncService } from "../../src/ingestion";
import { CollectionWatchService } from "../../src/serve/watch-service";
import { safeRm } from "../helpers/cleanup";
import {
  coll,
  createSyncResult,
  fakeWatch,
  installWatchServiceSyncReset,
  stubStore,
} from "./helpers/watch-service-round6-fixtures";

installWatchServiceSyncReset();

describe("syncCollection inventory / inactivation errors", () => {
  test("listDocuments failure is not false success", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-r6-listdocs-"));
    try {
      await writeFile(join(root, "a.md"), "a");
      // Real syncCollection against a small tree + failing inventory phase.
      const realStore = {
        listActiveDirectChildSourcePaths: async () => ({
          ok: true,
          value: [],
        }),
        listActiveDescendantSourcePaths: async () => ({
          ok: true,
          value: [],
        }),
        listActiveSourcePaths: async () => ({ ok: true, value: [] }),
        listDocuments: async () => ({
          ok: false as const,
          error: {
            code: "QUERY_FAILED" as const,
            message: "listDocuments boom",
          },
        }),
        listRecordDocuments: async () => ({ ok: true, value: [] }),
        getDocument: async () => ({ ok: true, value: null }),
        upsertDocument: async () => ({
          ok: true,
          value: { id: 1, docid: "d1" },
        }),
        replaceChunks: async () => ({ ok: true, value: undefined }),
        replaceLinks: async () => ({ ok: true, value: undefined }),
        setDocTags: async () => ({ ok: true, value: undefined }),
        putContent: async () => ({ ok: true, value: undefined }),
        getContent: async () => ({ ok: true, value: null }),
        recordIngestError: async () => ({ ok: true, value: undefined }),
        clearIngestErrors: async () => ({ ok: true, value: undefined }),
        getBacklinksForDoc: async () => ({ ok: true, value: [] }),
        getEdgeBacklinksForDoc: async () => ({ ok: true, value: [] }),
        backfillDocEdges: async () => ({ ok: true, value: 0 }),
        setDocEdges: async () => ({ ok: true, value: undefined }),
        getLinksForDoc: async () => ({ ok: true, value: [] }),
      } as unknown as SqliteAdapter;

      const result = await defaultSyncService.syncCollection(
        coll("notes", root),
        realStore,
        { projectTypedEdges: false, runUpdateCmd: false }
      );
      expect(
        result.errors.some((e) => e.message.includes("listDocuments"))
      ).toBe(true);
      expect(result.filesErrored).toBeGreaterThanOrEqual(1);
    } finally {
      await safeRm(root);
    }
  });

  test("markInactive failure during missing-source phase surfaces filesErrored", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-r6-mark-inv-"));
    try {
      await writeFile(join(root, "live.md"), "live");
      const store = {
        listDocuments: async () => ({
          ok: true as const,
          value: [
            {
              id: 1,
              docid: "live",
              collection: "notes",
              relPath: "live.md",
              active: true,
            },
            {
              id: 2,
              docid: "gone",
              collection: "notes",
              relPath: "gone.md",
              active: true,
            },
          ] as DocumentRow[],
        }),
        markInactive: async () => ({
          ok: false as const,
          error: {
            code: "QUERY_FAILED" as const,
            message: "markInactive boom",
          },
        }),
        listRecordDocuments: async () => ({ ok: true, value: [] }),
        getDocument: async (_c: string, relPath: string) => {
          if (relPath === "live.md") {
            return {
              ok: true as const,
              value: {
                id: 1,
                docid: "live",
                collection: "notes",
                relPath: "live.md",
                active: true,
                mirrorHash: null,
              } as unknown as DocumentRow,
            };
          }
          return { ok: true as const, value: null };
        },
        upsertDocument: async () => ({
          ok: true,
          value: { id: 1, docid: "live" },
        }),
        replaceChunks: async () => ({ ok: true, value: undefined }),
        replaceLinks: async () => ({ ok: true, value: undefined }),
        setDocTags: async () => ({ ok: true, value: undefined }),
        putContent: async () => ({ ok: true, value: "h" }),
        getContent: async () => ({ ok: true, value: null }),
        recordIngestError: async () => ({ ok: true, value: undefined }),
        clearIngestErrors: async () => ({ ok: true, value: undefined }),
        getBacklinksForDoc: async () => ({ ok: true, value: [] }),
        getEdgeBacklinksForDoc: async () => ({ ok: true, value: [] }),
        backfillDocEdges: async () => ({ ok: true, value: 0 }),
        setDocEdges: async () => ({ ok: true, value: undefined }),
        getLinksForDoc: async () => ({ ok: true, value: [] }),
        beginTransaction: async () => ({ ok: true, value: undefined }),
        commitTransaction: async () => ({ ok: true, value: undefined }),
        rollbackTransaction: async () => ({ ok: true, value: undefined }),
      } as unknown as SqliteAdapter;

      const result = await defaultSyncService.syncCollection(
        coll("notes", root),
        store,
        { projectTypedEdges: false, runUpdateCmd: false }
      );
      expect(result.filesMarkedInactive).toBe(0);
      expect(result.filesErrored).toBeGreaterThanOrEqual(1);
      expect(
        result.errors.some((e) => e.message.includes("markInactive"))
      ).toBe(true);
      expect(result.files?.some((f) => f.relPath === "gone.md")).toBe(true);
    } finally {
      await safeRm(root);
    }
  });

  test("overflow full-reconcile listDocuments failure keeps durable generation retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-r6-ov-list-"));
    let cb: ((e: string, f: string | null) => void) | undefined;
    let collectionCalls = 0;
    try {
      await writeFile(join(root, "seed.md"), "s");
      defaultSyncService.syncCollection = (async () => {
        collectionCalls += 1;
        if (collectionCalls < 2) {
          return createSyncResult({
            filesProcessed: 1,
            filesErrored: 1,
            errors: [
              {
                relPath: "",
                code: "QUERY_FAILED",
                message: "listDocuments boom",
              },
            ],
          });
        }
        return createSyncResult({
          filesProcessed: 1,
          filesUpdated: 1,
          files: [{ relPath: "seed.md", status: "updated" }],
        });
      }) as typeof defaultSyncService.syncCollection;
      defaultSyncService.syncPaths = (async () =>
        createSyncResult()) as typeof defaultSyncService.syncPaths;

      const service = new CollectionWatchService({
        collections: [coll("notes", root)],
        eventBus: null,
        scheduler: null,
        store: stubStore(),
        flushDebounceMs: 20,
        maxFlushDelayMs: 120,
        snapshotEntryCeiling: 0,
        watchFactory: fakeWatch((c) => {
          cb = c;
        }),
      });
      service.start();
      await Bun.sleep(120);
      cb?.("change", null);
      await Bun.sleep(1_800);
      expect(collectionCalls).toBeGreaterThanOrEqual(2);
      expect(service.getState().queuedCollections).toEqual([]);
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });

  test("overflow full-reconcile markInactive failure keeps durable generation retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-r6-ov-mark-"));
    let cb: ((e: string, f: string | null) => void) | undefined;
    let collectionCalls = 0;
    try {
      await writeFile(join(root, "seed.md"), "s");
      defaultSyncService.syncCollection = (async () => {
        collectionCalls += 1;
        if (collectionCalls < 2) {
          return createSyncResult({
            filesProcessed: 1,
            filesErrored: 1,
            files: [
              {
                relPath: "gone.md",
                status: "error",
                errorCode: "QUERY_FAILED",
                errorMessage: "markInactive boom",
              },
            ],
            errors: [
              {
                relPath: "gone.md",
                code: "QUERY_FAILED",
                message: "markInactive boom",
              },
            ],
          });
        }
        return createSyncResult({
          filesProcessed: 1,
          filesMarkedInactive: 1,
          files: [{ relPath: "gone.md", status: "updated" }],
        });
      }) as typeof defaultSyncService.syncCollection;

      const service = new CollectionWatchService({
        collections: [coll("notes", root)],
        eventBus: null,
        scheduler: null,
        store: stubStore(),
        flushDebounceMs: 20,
        maxFlushDelayMs: 120,
        snapshotEntryCeiling: 0,
        watchFactory: fakeWatch((c) => {
          cb = c;
        }),
      });
      service.start();
      await Bun.sleep(120);
      cb?.("change", null);
      await Bun.sleep(1_800);
      expect(collectionCalls).toBeGreaterThanOrEqual(2);
      expect(service.getState().queuedCollections).toEqual([]);
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });
});
