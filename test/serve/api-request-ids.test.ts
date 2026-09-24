/**
 * REST request IDs and the leased document save (fn-170 R3/R6).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises mkdtemp: temp fixture root, no Bun equivalent
import { mkdtemp } from "node:fs/promises";
// node:os tmpdir: no Bun equivalent
import { tmpdir } from "node:os";
// node:path has no Bun path utilities
import { join } from "node:path";

import { acquireWriteLock } from "../../src/core/file-lock";
import { defaultSyncService } from "../../src/ingestion";
import {
  handleCreateCapture,
  handleMemoryRemember,
  handleRequestStatus,
  handleUpdateDoc,
} from "../../src/serve/routes/api";
import { safeRm } from "../helpers/cleanup";
import {
  type OpSeed,
  openReceiptHarness,
  type ReceiptHarness,
  seedOp,
} from "../helpers/request-receipts";

let h: ReceiptHarness;

beforeEach(async () => {
  h = await openReceiptHarness(await mkdtemp(join(tmpdir(), "gno-rest-req-")));
});

afterEach(async () => {
  await h.store.close();
  await safeRm(h.root);
});

const ctx = () =>
  ({
    current: { config: h.config },
    config: h.config,
    scheduler: null,
    eventBus: null,
    watchService: null,
  }) as never;

const post = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });

const save = (
  seed: OpSeed,
  body: Record<string, unknown>,
  lockWaitMs = 5_000
) =>
  handleUpdateDoc(
    ctx(),
    h.store,
    seed.docid ?? "",
    new Request("http://localhost/api/docs/doc", {
      method: "PUT",
      body: JSON.stringify({ uri: seed.docUri, ...body }),
    }),
    {
      lockPath: h.lockPath,
      lockWaitMs,
      syncCollection: async () => {
        throw new Error("deferred sync is not exercised here");
      },
    }
  );

describe("document saves under the write lease", () => {
  test("concurrent saves from one revision cannot both win", async () => {
    const seed = await seedOp(h, "document-update");
    const responses = await Promise.all(
      ["A", "B"].map((content) =>
        save(seed, { content, expectedSourceHash: seed.sourceHash })
      )
    );
    const statuses = responses
      .map((response) => response.status)
      .sort((left, right) => left - right);
    expect(statuses).toEqual([200, 409]);
    const loser = responses.find((response) => response.status === 409);
    expect(await loser?.json()).toMatchObject({ error: { code: "CONFLICT" } });
    expect(["A", "B"]).toContain(
      await Bun.file(join(h.notes.path, "doc.md")).text()
    );
  });

  test("a held lease returns the typed busy error without writing", async () => {
    const seed = await seedOp(h, "document-update");
    const lease = await acquireWriteLock(h.lockPath, 1_000);
    try {
      const response = await save(seed, { content: "blocked" }, 200);
      expect(response.status).toBe(409);
      expect(
        ((await response.json()) as { error: { code: string } }).error.code
      ).toBe("LOCKED");
    } finally {
      await lease?.release();
    }
    expect(await Bun.file(join(h.notes.path, "doc.md")).text()).toBe(
      "# Doc\n\nv0\n"
    );
  });
});

test("an interrupted tag-only save never overwrites newer tags", async () => {
  await Bun.write(join(h.notes.path, "data.txt"), "plain text\n");
  await defaultSyncService.syncCollection(h.notes, h.store, {
    runUpdateCmd: false,
    gitPull: false,
  });
  const doc = await h.store.getDocument("notes", "data.txt");
  if (!doc.ok || !doc.value) throw new Error("fixture not indexed");
  const { docid, uri } = doc.value;
  const tagSave = (tags: string[], requestId?: string, crash = false) =>
    handleUpdateDoc(
      ctx(),
      h.store,
      docid,
      new Request("http://localhost/api/docs/data", {
        method: "PUT",
        body: JSON.stringify({ uri, tags, requestId }),
      }),
      {
        lockPath: h.lockPath,
        requestCheckpoint: (stage) => {
          if (crash && stage === "published")
            throw new Error("simulated crash");
        },
      }
    );
  const userTags = async () => {
    const rows = await h.store.getTagsForDoc(doc.value!.id);
    return rows.ok ? rows.value.map((row) => row.tag) : [];
  };

  expect((await tagSave(["stale"], "tags-a", true)).status).toBe(500);
  expect((await tagSave(["newer"])).status).toBe(200);
  const retried = await tagSave(["stale"], "tags-a");
  expect(retried.status).toBe(409);
  expect(await retried.json()).toMatchObject({
    error: { code: "REQUEST_RECOVERY_CONFLICT" },
  });
  expect(await userTags()).toEqual(["newer"]);
});

describe("REST request IDs", () => {
  test("a capture retry replays with its original status and is inspectable", async () => {
    const body = {
      collection: "notes",
      title: "REST retry",
      content: "once",
      collisionPolicy: "create_with_suffix",
      requestId: "rest-capture-1",
    };
    const deps = { lockPath: h.lockPath };
    const first = await handleCreateCapture(
      ctx(),
      h.store,
      post("/api/capture", body),
      deps
    );
    const again = await handleCreateCapture(
      ctx(),
      h.store,
      post("/api/capture", body),
      deps
    );
    expect([first.status, again.status]).toEqual([201, 201]);
    const [a, b] = [await first.json(), await again.json()];
    expect(b).toEqual({ ...a, request: { ...a.request, replayed: true } });

    const status = await handleRequestStatus(h.store, "rest-capture-1");
    expect(await status.json()).toMatchObject({
      status: "committed",
      result: { uri: a.uri, contentHash: a.contentHash },
    });
    expect(
      await (await handleRequestStatus(h.store, "never-sent")).json()
    ).toEqual({ requestId: "never-sent", status: "not_found" });
  });

  test.each([
    [
      "an invalid capture request ID",
      () =>
        handleCreateCapture(
          ctx(),
          h.store,
          post("/api/capture", {
            collection: "notes",
            content: "x",
            requestId: "not valid",
          }),
          { lockPath: h.lockPath }
        ),
    ],
    [
      "a request ID on a candidates-only remember",
      () =>
        handleMemoryRemember(
          ctx(),
          h.store,
          post("/api/memory/remember", {
            caller: "c",
            session: "s",
            text: "fact",
            collection: "memory",
            scopes: ["project:x"],
            requestId: "r1",
          }),
          { lockPath: h.lockPath }
        ),
    ],
  ])("%s is rejected before admission", async (_label, send) => {
    const response = await send();
    expect(response.status).toBe(400);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code
    ).toBe("REQUEST_ID_INVALID");
  });
});
