import { expect, test } from "bun:test";
// Bun has no temporary-directory lifecycle API or portable path helpers.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { createVectorStatsPort } from "../../src/store/vector/stats";
import { safeRm } from "../helpers/cleanup";

test("shutdown rolls back a suspended writer and fences its queued and late continuations across reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "gno-shutdown-fence-"));
  const store = new SqliteAdapter();
  const pause = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let lateDenied = false;
  let queuedRan = false;
  let completions = 0;
  try {
    expect((await store.open(join(root, "index.db"), "unicode61")).ok).toBe(
      true
    );
    await store.syncCollections([
      {
        name: "notes",
        path: root,
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ]);
    await store.upsertDocument({
      collection: "notes",
      relPath: "synthetic.md",
      sourceHash: "shutdown-fixture",
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: 3,
      sourceMtime: "2026-01-01T00:00:00Z",
      mirrorHash: "shutdown-body",
    });
    await store.upsertContent("shutdown-body", "a\nb\nc");
    await store.upsertChunks(
      "shutdown-body",
      [0, 1, 2].map((seq) => ({
        seq,
        pos: seq * 2,
        text: String(seq),
        startLine: seq + 1,
        endLine: seq + 1,
      }))
    );
    const db = store.getRawDb();
    const checkpoint = (seq: number): void => {
      store
        .getRawDb()
        .run(
          "INSERT INTO content_vectors (mirror_hash,seq,model,embed_fingerprint,embedding) VALUES ('shutdown-body',?,'synthetic','f',?)",
          [seq, new Uint8Array(4)]
        );
    };
    checkpoint(0);
    const write = store
      .withTransaction(async () => {
        checkpoint(1);
        entered.resolve();
        await pause.promise;
        try {
          store.getRawDb();
        } catch {
          lateDenied = true;
        }
        return "late success";
      })
      .then((result) => {
        completions++;
        return result;
      });
    await entered.promise;
    const queued = store.withTransaction(async () => {
      queuedRan = true;
    });
    store.beginShutdown(performance.now() + 40);
    expect(
      store
        .getRawDb()
        .query<{ timeout: number }, []>("PRAGMA busy_timeout")
        .get()?.timeout
    ).toBeLessThanOrEqual(40);
    const closing = store.close();
    // Reopen synchronously before the queued writer gets its microtask slot.
    const reopened = store.open(join(root, "index.db"), "unicode61");
    await closing;
    expect(() => db.exec("DELETE FROM content_vectors")).toThrow();
    expect((await queued).ok).toBe(false);
    expect((await reopened).ok).toBe(true);
    pause.resolve();
    expect((await write).ok).toBe(false);
    expect(completions).toBe(1);
    expect(lateDenied).toBe(true);
    expect(queuedRan).toBe(false);
    expect(
      store
        .getRawDb()
        .query("SELECT seq FROM content_vectors ORDER BY seq")
        .all()
    ).toEqual([{ seq: 0 }]);
    const stats = createVectorStatsPort(store.getRawDb());
    expect(await stats.countBacklog("synthetic", "f")).toEqual({
      ok: true,
      value: 2,
    });
    expect(
      (
        await store.withTransaction(async () => {
          checkpoint(1);
          checkpoint(2);
        })
      ).ok
    ).toBe(true);
    expect(await stats.countBacklog("synthetic", "f")).toEqual({
      ok: true,
      value: 0,
    });
  } finally {
    pause.resolve();
    await store.close();
    await safeRm(root);
  }
});
