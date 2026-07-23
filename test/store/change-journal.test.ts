import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DocumentInput } from "../../src/store/types";

import { encodeDocumentChangeCursor } from "../../src/core/change-journal";
import { SyncService } from "../../src/ingestion";
import { err, SqliteAdapter } from "../../src/store";
import { safeRm } from "../helpers/cleanup";

const DAY_MS = 86_400_000;

describe("document change journal", () => {
  let adapter: SqliteAdapter;
  let testDir = "";
  let dbPath = "";

  const document = (
    relPath: string,
    sourceHash: string,
    mirrorHash = `mirror-${sourceHash}`,
    observedAtMs = Date.now()
  ): DocumentInput => ({
    collection: "notes",
    relPath,
    sourceHash,
    sourceMime: "text/markdown",
    sourceExt: ".md",
    sourceSize: 32,
    sourceMtime: "2026-07-23T12:00:00.000Z",
    mirrorHash,
    changeJournal: { observedAtMs },
  });

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "gno-change-journal-test-"));
    dbPath = join(testDir, "index.sqlite");
    adapter = new SqliteAdapter();
    expect((await adapter.open(dbPath, "unicode61")).ok).toBe(true);
    expect(
      (
        await adapter.syncCollections([
          {
            name: "notes",
            path: testDir,
            pattern: "**/*",
            include: [],
            exclude: [],
          },
        ])
      ).ok
    ).toBe(true);
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(testDir);
  });

  test("records create, update, inactivate, and reactivate with exact hashes", async () => {
    const created = await adapter.upsertDocument(
      document("alpha.md", "source-a", "mirror-a")
    );
    expect(created.ok).toBe(true);

    expect(
      (
        await adapter.upsertDocument(
          document("alpha.md", "source-a", "mirror-a")
        )
      ).ok
    ).toBe(true);
    expect(
      (
        await adapter.upsertDocument(
          document("alpha.md", "source-b", "mirror-b")
        )
      ).ok
    ).toBe(true);
    const inactivated = await adapter.markInactive("notes", ["alpha.md"]);
    expect(inactivated.ok && inactivated.value).toBe(1);
    const repeatedInactive = await adapter.markInactive("notes", ["alpha.md"]);
    expect(repeatedInactive.ok && repeatedInactive.value).toBe(0);
    expect(
      (
        await adapter.upsertDocument(
          document("alpha.md", "source-b", "mirror-b")
        )
      ).ok
    ).toBe(true);

    const page = await adapter.listDocumentChanges();
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.changes.map(({ kind }) => kind)).toEqual([
      "create",
      "update",
      "inactivate",
      "reactivate",
    ]);
    expect(page.value.changes[0]).toMatchObject({
      documentId: created.ok ? created.value.id : -1,
      oldSourceHash: null,
      newSourceHash: "source-a",
      oldMirrorHash: null,
      newMirrorHash: "mirror-a",
      oldActive: null,
      newActive: true,
    });
    expect(page.value.changes[1]).toMatchObject({
      oldSourceHash: "source-a",
      newSourceHash: "source-b",
      oldMirrorHash: "mirror-a",
      newMirrorHash: "mirror-b",
    });
    expect(page.value.changes[2]).toMatchObject({
      oldActive: true,
      newActive: false,
    });
    expect(page.value.changes[3]).toMatchObject({
      oldActive: false,
      newActive: true,
    });
  });

  test("renames only through the explicit API and preserves stable identity", async () => {
    const created = await adapter.upsertDocument(
      document("old.md", "source-a", "mirror-a")
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const renamed = await adapter.renameDocument(
      "notes",
      "old.md",
      "folder/new.md"
    );
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.value.id).toBe(created.value.id);
    expect(renamed.value.sourceHash).toBe("source-a");
    expect(renamed.value.mirrorHash).toBe("mirror-a");

    expect(
      (await adapter.renameDocument("notes", "folder/new.md", "folder/new.md"))
        .ok
    ).toBe(true);
    const page = await adapter.listDocumentChanges();
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.changes.map(({ kind }) => kind)).toEqual([
      "create",
      "rename",
    ]);
    expect(page.value.changes[1]).toMatchObject({
      documentId: created.value.id,
      oldRelPath: "old.md",
      newRelPath: "folder/new.md",
      oldSourceHash: "source-a",
      newSourceHash: "source-a",
      oldMirrorHash: "mirror-a",
      newMirrorHash: "mirror-a",
    });
  });

  test("treats an ambiguous external move as create plus inactivate", async () => {
    await adapter.upsertDocument(document("old.md", "same", "same-mirror"));
    await adapter.upsertDocument(document("new.md", "same", "same-mirror"));
    await adapter.markInactive("notes", ["old.md"]);

    const page = await adapter.listDocumentChanges();
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.changes.map(({ kind }) => kind)).toEqual([
      "create",
      "create",
      "inactivate",
    ]);
  });

  test("rolls journal and document state back together", async () => {
    const failedCreate = await adapter.withTransaction(async () => {
      const created = await adapter.upsertDocument(document("rolled.md", "a"));
      expect(created.ok).toBe(true);
      throw new Error("rollback create");
    });
    expect(failedCreate.ok).toBe(false);
    const rolledDocument = await adapter.getDocument("notes", "rolled.md");
    expect(rolledDocument.ok && rolledDocument.value).toBeNull();
    const rolledChanges = await adapter.listDocumentChanges();
    expect(rolledChanges.ok && rolledChanges.value.changes).toHaveLength(0);

    await adapter.upsertDocument(document("kept.md", "a", "mirror-a"));
    const failedUpdate = await adapter.withTransaction(async () => {
      const updated = await adapter.upsertDocument(
        document("kept.md", "b", "mirror-b")
      );
      expect(updated.ok).toBe(true);
      throw new Error("rollback update");
    });
    expect(failedUpdate.ok).toBe(false);
    const keptDocument = await adapter.getDocument("notes", "kept.md");
    expect(keptDocument.ok && keptDocument.value?.sourceHash).toBe("a");
    const page = await adapter.listDocumentChanges();
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.changes.map(({ kind }) => kind)).toEqual(["create"]);
  });

  test("does not journal a sync whose downstream store write fails", async () => {
    await Bun.write(join(testDir, "failed.md"), "# Failed\n\nbody");
    adapter.upsertContent = async () =>
      err("QUERY_FAILED", "forced content failure");

    const result = await new SyncService().syncPaths(
      {
        name: "notes",
        path: testDir,
        pattern: "**/*",
        include: [],
        exclude: [],
      },
      adapter,
      ["failed.md"]
    );
    expect(result.files?.[0]?.status).toBe("error");
    const documentResult = await adapter.getDocument("notes", "failed.md");
    expect(documentResult.ok && documentResult.value).toBeNull();
    const changes = await adapter.listDocumentChanges();
    expect(changes.ok && changes.value.changes).toHaveLength(0);
  });

  test("coalesces concurrent identical lifecycle writes", async () => {
    const writes = await Promise.all(
      Array.from({ length: 16 }, () =>
        adapter.upsertDocument(document("race.md", "same", "same-mirror"))
      )
    );
    expect(writes.every(({ ok }) => ok)).toBe(true);
    let page = await adapter.listDocumentChanges();
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.changes.map(({ kind }) => kind)).toEqual(["create"]);

    await adapter.markInactive("notes", ["race.md"]);
    const reactivations = await Promise.all(
      Array.from({ length: 16 }, () =>
        adapter.upsertDocument(document("race.md", "same", "same-mirror"))
      )
    );
    expect(reactivations.every(({ ok }) => ok)).toBe(true);
    page = await adapter.listDocumentChanges();
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.changes.map(({ kind }) => kind)).toEqual([
      "create",
      "inactivate",
      "reactivate",
    ]);
  });

  test("paginates, expires pruned cursors, and preserves monotonic sequence", async () => {
    const baseTime = Date.now() - 2 * DAY_MS;
    for (let index = 0; index < 4; index += 1) {
      await adapter.upsertDocument(
        document(
          `${index}.md`,
          `source-${index}`,
          `mirror-${index}`,
          baseTime + index
        )
      );
    }

    const first = await adapter.listDocumentChanges({ limit: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.truncated).toBe(true);
    expect(first.value.nextCursor).not.toBeNull();

    const retention = await adapter.enforceDocumentChangeRetention(
      { maxAgeDays: 3650, maxEntries: 2, maxBytes: 1024 * 1024 },
      Date.now()
    );
    expect(retention.ok).toBe(true);
    if (!retention.ok) return;
    expect(retention.value.deleted).toBe(2);
    expect(retention.value.remainingEntries).toBe(2);

    const expired = await adapter.listDocumentChanges({
      cursor: first.value.nextCursor ?? "",
    });
    expect(expired.ok).toBe(true);
    if (!expired.ok) return;
    expect(expired.value.cursorExpired).toBe(true);
    expect(expired.value.changes).toEqual([]);

    const retained = await adapter.listDocumentChanges();
    expect(retained.ok).toBe(true);
    if (!retained.ok) return;
    expect(retained.value.changes.map(({ sequence }) => sequence)).toEqual([
      3, 4,
    ]);
  });

  test("enforces age and byte retention, then discloses purge expiry", async () => {
    const baseTime = Date.now() - 2 * DAY_MS;
    await adapter.upsertDocument(document("old.md", "old", "old", baseTime));
    await adapter.upsertDocument(document("new.md", "new", "new", Date.now()));
    const before = await adapter.listDocumentChanges();
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const oldCursor = encodeDocumentChangeCursor(0);

    const aged = await adapter.enforceDocumentChangeRetention(
      { maxAgeDays: 1, maxEntries: 100, maxBytes: 1024 * 1024 },
      Date.now()
    );
    expect(aged.ok).toBe(true);
    if (!aged.ok) return;
    expect(aged.value.deleted).toBe(1);

    const remaining = await adapter.listDocumentChanges();
    expect(remaining.ok).toBe(true);
    if (!remaining.ok) return;
    const lastByteSize = remaining.value.changes[0]?.byteSize ?? 1;
    const bytePruned = await adapter.enforceDocumentChangeRetention(
      { maxAgeDays: 3650, maxEntries: 100, maxBytes: lastByteSize - 1 },
      Date.now()
    );
    expect(bytePruned.ok).toBe(true);
    if (!bytePruned.ok) return;
    expect(bytePruned.value.deleted).toBe(1);

    await adapter.upsertDocument(document("after.md", "after", "after"));
    const purge = await adapter.purgeDocumentChanges();
    expect(purge.ok).toBe(true);
    if (!purge.ok) return;
    expect(purge.value.deleted).toBe(1);
    const expired = await adapter.listDocumentChanges({ cursor: oldCursor });
    expect(expired.ok && expired.value.cursorExpired).toBe(true);
  });

  test("bounds reserved structural summaries and never stores source content", async () => {
    const headings = Array.from(
      { length: 40 },
      (_, index) => `${index}-${"x".repeat(400)}`
    );
    await adapter.upsertDocument({
      ...document("bounded.md", "source", "mirror"),
      changeJournal: {
        structureDelta: {
          headings: { added: headings, removed: [] },
        },
      },
    });

    const page = await adapter.listDocumentChanges();
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    const change = page.value.changes[0];
    expect(change?.structureDelta.truncated).toBe(true);
    expect(change?.structureDelta.headings.added).toHaveLength(16);
    expect(
      change?.structureDelta.headings.added.every(
        (heading) => heading.length <= 256
      )
    ).toBe(true);
    const columns = adapter
      .getRawDb()
      .query<{ name: string }, []>("PRAGMA table_info(document_changes)")
      .all()
      .map(({ name }) => name);
    expect(columns).not.toContain("content");
    expect(columns).not.toContain("markdown");
  });
});
