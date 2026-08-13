/** Host review round-6: inactivation lookup/edge error surfaces. */

import { describe, expect, test } from "bun:test";
// node:fs/promises — test fixture setup
import { mkdtemp, unlink, writeFile } from "node:fs/promises";
// node:os — tmpdir
import { tmpdir } from "node:os";
// node:path — Bun has no path utilities
import { join } from "node:path";

import type { CollectionSyncResult } from "../../src/ingestion";
import type { DocumentRow } from "../../src/store/types";

import { defaultSyncService } from "../../src/ingestion";
import { CollectionWatchService } from "../../src/serve/watch-service";
import { safeRm } from "../helpers/cleanup";
import {
  coll,
  createSyncResult,
  fakeWatch,
  installWatchServiceSyncReset,
  originalInactivate,
  statefulInactiveStore,
  stubStore,
} from "./helpers/watch-service-round6-fixtures";

installWatchServiceSyncReset();

describe("inactivateAbsentSources error surfaces", () => {
  test("getDocument ok:false is per-file error; not skipped", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-r6-getdoc-"));
    try {
      const store = stubStore({
        listRecordDocuments: async () => ({ ok: true, value: [] }),
        getDocument: async () => ({
          ok: false as const,
          error: {
            code: "QUERY_FAILED" as const,
            message: "lookup boom",
          },
        }),
        getBacklinksForDoc: async () => ({ ok: true, value: [] }),
        getEdgeBacklinksForDoc: async () => ({ ok: true, value: [] }),
      });
      const result = await defaultSyncService.inactivateAbsentSources(
        coll("notes", root),
        store,
        ["missing.md"],
        { projectTypedEdges: false }
      );
      expect(result.filesErrored).toBe(1);
      expect(result.filesMarkedInactive).toBe(0);
      expect(result.files?.[0]?.status).toBe("error");
      expect(result.files?.[0]?.errorCode).toBe("QUERY_FAILED");
      expect(result.files?.[0]?.status).not.toBe("skipped");
    } finally {
      await safeRm(root);
    }
  });

  test("getDocument failure blocks watcher snapshot advance and retries", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-r6-getdoc-watch-"));
    let cb: ((e: string, f: string | null) => void) | undefined;
    let inactivateCalls = 0;
    let getDocCalls = 0;
    try {
      await writeFile(join(root, "keep.md"), "k");
      await writeFile(join(root, "gone.md"), "g");
      const { store, inactive, docs } = statefulInactiveStore(
        ["keep.md", "gone.md"],
        {
          getDocument: async (_c, relPath) => {
            if (relPath === "gone.md") {
              getDocCalls += 1;
              if (getDocCalls < 2) {
                return {
                  ok: false as const,
                  error: {
                    code: "QUERY_FAILED" as const,
                    message: "transient lookup",
                  },
                };
              }
            }
            const row = docs.get(relPath);
            if (!row) {
              return { ok: true as const, value: null };
            }
            return {
              ok: true as const,
              value: {
                id: row.id,
                docid: row.docid,
                collection: "notes",
                relPath,
                active: row.active,
              } as DocumentRow,
            };
          },
        }
      );

      defaultSyncService.inactivateAbsentSources = (async (
        collection,
        _s,
        relPaths,
        options
      ) => {
        inactivateCalls += 1;
        return originalInactivate(collection, store, relPaths, options);
      }) as typeof defaultSyncService.inactivateAbsentSources;
      defaultSyncService.syncPaths = (async (_c, _s, relPaths) =>
        createSyncResult({
          filesProcessed: relPaths.filter((p) => p !== "gone.md").length,
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
      service.start();
      await Bun.sleep(200);
      await unlink(join(root, "gone.md"));
      cb?.("rename", "gone.md");
      await Bun.sleep(1_800);
      expect(inactivateCalls).toBeGreaterThanOrEqual(2);
      expect(getDocCalls).toBeGreaterThanOrEqual(2);
      expect(inactive).toContain("gone.md");
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });

  test("backlink lookup failure surfaces as per-file error", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-r6-backlink-"));
    try {
      const { store } = statefulInactiveStore(["gone.md"], {
        getBacklinksForDoc: async () => ({
          ok: false as const,
          error: {
            code: "QUERY_FAILED" as const,
            message: "backlink boom",
          },
        }),
      });
      const result = await defaultSyncService.inactivateAbsentSources(
        coll("notes", root),
        store,
        ["gone.md"],
        { projectTypedEdges: false }
      );
      expect(result.filesErrored).toBe(1);
      expect(result.filesMarkedInactive).toBe(0);
      expect(result.files?.[0]?.errorCode).toBe("QUERY_FAILED");
      expect(result.files?.[0]?.errorMessage).toContain("backlink");
    } finally {
      await safeRm(root);
    }
  });

  test("clear typed-edge failure surfaces in result.errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-r6-clear-edge-"));
    try {
      const { store } = statefulInactiveStore(["gone.md"], {
        setDocEdges: async () => ({
          ok: false as const,
          error: {
            code: "QUERY_FAILED" as const,
            message: "clear edges boom",
          },
        }),
      });
      const result = await defaultSyncService.inactivateAbsentSources(
        coll("notes", root),
        store,
        ["gone.md"],
        { projectTypedEdges: true }
      );
      expect(result.filesMarkedInactive).toBe(1);
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
      expect(result.errors.some((e) => e.message.includes("clear edges"))).toBe(
        true
      );
    } finally {
      await safeRm(root);
    }
  });

  test("record physical source with multiple logical docs inactivates all", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-r6-record-multi-"));
    try {
      const inactive: string[] = [];
      const store = stubStore({
        listRecordDocuments: async () => ({
          ok: true as const,
          value: [
            {
              id: 2,
              docid: "rec-1",
              collection: "notes",
              relPath: "bundle.jsonl#1",
              active: true,
            },
            {
              id: 3,
              docid: "rec-2",
              collection: "notes",
              relPath: "bundle.jsonl#2",
              active: true,
            },
          ] as DocumentRow[],
        }),
        getDocument: async () => ({
          ok: true as const,
          value: {
            id: 1,
            docid: "phys",
            collection: "notes",
            relPath: "bundle.jsonl",
            active: true,
          } as DocumentRow,
        }),
        markInactive: async (_c, relPaths) => {
          inactive.push(...relPaths);
          return { ok: true as const, value: relPaths.length };
        },
        getBacklinksForDoc: async () => ({ ok: true, value: [] }),
        getEdgeBacklinksForDoc: async () => ({ ok: true, value: [] }),
      });
      const result = await defaultSyncService.inactivateAbsentSources(
        coll("notes", root),
        store,
        ["bundle.jsonl"],
        { projectTypedEdges: false }
      );
      expect(result.filesMarkedInactive).toBe(3);
      expect(inactive).toContain("bundle.jsonl");
      expect(inactive).toContain("bundle.jsonl#1");
      expect(inactive).toContain("bundle.jsonl#2");
      // Deduped paths — no duplicate markInactive entries.
      expect(new Set(inactive).size).toBe(inactive.length);
    } finally {
      await safeRm(root);
    }
  });
});

describe("edge failure retains watcher authority", () => {
  test("inactivate edge clear failure requeues without losing dirty work", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-r6-edge-auth-"));
    let cb: ((e: string, f: string | null) => void) | undefined;
    let inactivateCalls = 0;
    const completeResults: CollectionSyncResult[] = [];
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
        const result = await originalInactivate(
          collection,
          store,
          relPaths,
          options
        );
        if (inactivateCalls === 1) {
          return {
            ...result,
            errors: [
              ...result.errors,
              {
                relPath: "(doc:1)",
                code: "QUERY_FAILED",
                message: "clear edges boom",
              },
            ],
          };
        }
        return result;
      }) as typeof defaultSyncService.inactivateAbsentSources;
      defaultSyncService.syncPaths = (async (_c, _s, relPaths) =>
        createSyncResult({
          filesProcessed: relPaths.filter((p) => p !== "gone.md").length,
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
        callbacks: {
          onSyncComplete: (event) => {
            completeResults.push(event.result);
          },
        },
        flushDebounceMs: 25,
        maxFlushDelayMs: 150,
        watchFactory: fakeWatch((c) => {
          cb = c;
        }),
      });
      service.start();
      await Bun.sleep(200);
      await unlink(join(root, "gone.md"));
      cb?.("rename", "gone.md");
      await Bun.sleep(1_800);
      expect(inactivateCalls).toBeGreaterThanOrEqual(2);
      expect(inactive).toContain("gone.md");
      expect(
        completeResults.some((r) =>
          r.errors.some((e) => e.message.includes("clear edges"))
        )
      ).toBe(true);
      expect(service.getState().queuedCollections).toEqual([]);
      await service.dispose();
    } finally {
      await safeRm(root);
    }
  });
});
