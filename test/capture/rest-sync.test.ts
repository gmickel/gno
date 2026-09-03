/**
 * REST capture parity (fn-132 R1): `/api/capture` succeeds only once the
 * capture is lexically retrievable, under the shared write lease.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CaptureReceipt } from "../../src/core/capture";

import { acquireWriteLock } from "../../src/core/file-lock";
import { defaultSyncService } from "../../src/ingestion";
import {
  executeResidentCapturePlan,
  planResidentCapture,
} from "../../src/serve/capture-service";
import { handleCreateCapture } from "../../src/serve/routes/api";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

const failingSyncPaths: typeof defaultSyncService.syncPaths = async (
  _collection,
  _store,
  relPaths
) => ({
  collection: "notes",
  filesProcessed: 1,
  filesAdded: 0,
  filesUpdated: 0,
  filesUnchanged: 0,
  filesErrored: 1,
  filesSkipped: 0,
  filesMarkedInactive: 0,
  durationMs: 1,
  files: [
    {
      relPath: relPaths[0] ?? "",
      status: "error",
      errorCode: "PARSE_ERROR",
      errorMessage: "bad markdown",
    },
  ],
  errors: [],
});

describe("REST capture syncs before success", () => {
  let tmpDir: string;
  let store: SqliteAdapter;
  let lockPath: string;

  const config = () => ({
    version: "1.0",
    ftsTokenizer: "porter",
    collections: [
      {
        name: "notes",
        path: join(tmpDir, "notes"),
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ],
    contexts: [],
  });

  const ctxHolder = () =>
    ({
      current: {},
      config: config(),
      scheduler: null,
      eventBus: null,
      watchService: null,
    }) as never;

  const captureRequest = (body: Record<string, unknown>) =>
    new Request("http://localhost/api/capture", {
      method: "POST",
      body: JSON.stringify({ collection: "notes", ...body }),
    });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gno-rest-capture-"));
    lockPath = join(tmpDir, ".mcp-write.lock");
    await mkdir(join(tmpDir, "notes"), { recursive: true });
    store = new SqliteAdapter();
    expect((await store.open(join(tmpDir, "index.sqlite"), "porter")).ok).toBe(
      true
    );
    expect((await store.syncCollections(config().collections)).ok).toBe(true);
  });

  afterEach(async () => {
    await store.close();
    await safeRm(tmpDir);
  });

  test("returns 201 with sync completed and an immediate FTS hit", async () => {
    const res = await handleCreateCapture(
      ctxHolder(),
      store,
      captureRequest({
        content: "# Loop\n\nzebrafish retrievable in one turn",
        relPath: "loop.md",
      }),
      { lockPath }
    );
    expect(res.status).toBe(201);
    const receipt = (await res.json()) as CaptureReceipt;
    expect(receipt.sync).toEqual({ status: "completed" });
    expect(receipt.embed.status).toBe("not_requested");
    expect(receipt.docid).toBeString();
    const hit = await store.searchFts("zebrafish", { limit: 5 });
    expect(hit.ok && hit.value.some((row) => row.relPath === "loop.md")).toBe(
      true
    );
  });

  test("open_existing syncs an unindexed disk file and returns 200", async () => {
    await Bun.write(
      join(tmpDir, "notes", "on-disk.md"),
      "# On disk\n\nquokka body\n"
    );
    const res = await handleCreateCapture(
      ctxHolder(),
      store,
      captureRequest({
        content: "ignored",
        relPath: "on-disk.md",
        collisionPolicy: "open_existing",
      }),
      { lockPath }
    );
    expect(res.status).toBe(200);
    const receipt = (await res.json()) as CaptureReceipt;
    expect(receipt.openedExisting).toBe(true);
    expect(receipt.sync.status).toBe("completed");
    expect(receipt.docid).toBeString();
    const hit = await store.searchFts("quokka", { limit: 5 });
    expect(
      hit.ok && hit.value.some((row) => row.relPath === "on-disk.md")
    ).toBe(true);
  });

  test("sync failure is a 500 CAPTURE_SYNC_FAILED carrying the write receipt", async () => {
    const res = await handleCreateCapture(
      ctxHolder(),
      store,
      captureRequest({ content: "written but unsynced", relPath: "broken.md" }),
      { lockPath, syncPaths: failingSyncPaths }
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      error: {
        code: string;
        message: string;
        details: { absPath: string; relPath: string; uri: string };
      };
    };
    expect(body.error.code).toBe("CAPTURE_SYNC_FAILED");
    expect(body.error.message).toContain("PARSE_ERROR - bad markdown");
    expect(body.error.details).toMatchObject({
      absPath: join(tmpDir, "notes", "broken.md"),
      relPath: "broken.md",
      uri: "gno://notes/broken.md",
    });
    expect(await Bun.file(body.error.details.absPath).text()).toContain(
      "written but unsynced"
    );
  });

  test("lease busy is a 409 LOCKED and writes nothing", async () => {
    const holder = await acquireWriteLock(lockPath, 1000);
    expect(holder).not.toBeNull();
    try {
      const res = await handleCreateCapture(
        ctxHolder(),
        store,
        captureRequest({ content: "blocked", relPath: "blocked.md" }),
        { lockPath, lockWaitMs: 0 }
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("LOCKED");
      expect(await Bun.file(join(tmpDir, "notes", "blocked.md")).exists()).toBe(
        false
      );
    } finally {
      await holder?.release();
    }
  });

  test("job mode (browser clipper) keeps the 202 pending contract", async () => {
    const planned = await planResidentCapture(ctxHolder(), store, {
      collection: "notes",
      content: "clipped",
      relPath: "clip.md",
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const result = await executeResidentCapturePlan(
      ctxHolder(),
      store,
      planned
    );
    expect(result.status).toBe(202);
    expect((result.body as CaptureReceipt).sync.status).toBe("pending");
  });
});
