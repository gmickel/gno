import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Collection } from "../../src/config/types";
import type { WalkerPort } from "../../src/ingestion";

import { SyncService } from "../../src/ingestion";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

describe("incremental sync orchestration", () => {
  let tempDir: string;
  let store: SqliteAdapter;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "gno-sync-incremental-"));
    store = new SqliteAdapter();
    const openResult = await store.open(
      join(tempDir, "index.sqlite"),
      "porter"
    );
    expect(openResult.ok).toBe(true);
  });

  afterEach(async () => {
    await store.close();
    await safeRm(tempDir);
  });

  test("syncAll performs one global projection after all collections", async () => {
    const firstDir = join(tempDir, "first");
    const secondDir = join(tempDir, "second");
    await mkdir(firstDir);
    await mkdir(secondDir);
    await writeFile(join(firstDir, "one.md"), "# One\n");
    await writeFile(join(secondDir, "two.md"), "# Two\n");
    const collections: Collection[] = [
      {
        name: "first",
        path: firstDir,
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
      {
        name: "second",
        path: secondDir,
        pattern: "**/*.md",
        include: [],
        exclude: [],
      },
    ];
    await store.syncCollections(collections);

    const originalBackfill = store.backfillDocEdges.bind(store);
    const backfill = mock(originalBackfill);
    store.backfillDocEdges = backfill;
    const service = new SyncService();
    const allResult = await service.syncAll(collections, store);

    expect(allResult.totalFilesProcessed).toBe(2);
    expect(backfill).toHaveBeenCalledTimes(1);

    backfill.mockClear();
    await service.syncCollection(collections[0]!, store);
    expect(backfill).toHaveBeenCalledTimes(1);
  });

  test("syncPaths updates changed and backlink sources without walking", async () => {
    const collectionDir = join(tempDir, "notes");
    await mkdir(collectionDir);
    await writeFile(
      join(collectionDir, "source.md"),
      "# Source\n\n[[Target]]\n"
    );
    await writeFile(join(collectionDir, "opaque.md"), "# Target\n");
    await writeFile(join(collectionDir, "unrelated.md"), "# Unrelated\n");
    const collection: Collection = {
      name: "notes",
      path: collectionDir,
      pattern: "**/*.md",
      include: [],
      exclude: [],
    };
    await store.syncCollections([collection]);
    await new SyncService().syncCollection(collection, store);

    const sourceBefore = await store.getDocument("notes", "source.md");
    const targetBefore = await store.getDocument("notes", "opaque.md");
    expect(sourceBefore.ok && sourceBefore.value).toBeTruthy();
    expect(targetBefore.ok && targetBefore.value).toBeTruthy();
    if (
      !(
        sourceBefore.ok &&
        sourceBefore.value &&
        targetBefore.ok &&
        targetBefore.value
      )
    ) {
      return;
    }
    const initialEdges = await store.getEdgesForDoc(sourceBefore.value.id);
    expect(initialEdges.ok && initialEdges.value.length).toBe(1);

    const walkMock = mock(() => {
      throw new Error("incremental sync must not walk the collection");
    });
    const walker: WalkerPort = { walk: walkMock };
    const incrementalService = new SyncService(walker);
    await writeFile(join(collectionDir, "opaque.md"), "# Renamed\n");
    const changed = await incrementalService.syncPaths(collection, store, [
      "opaque.md",
    ]);
    expect(changed.filesProcessed).toBe(1);
    expect(walkMock).not.toHaveBeenCalled();

    const updatedEdges = await store.getEdgesForDoc(sourceBefore.value.id);
    expect(updatedEdges.ok && updatedEdges.value).toHaveLength(0);

    await unlink(join(collectionDir, "opaque.md"));
    const deleted = await incrementalService.syncPaths(collection, store, [
      "opaque.md",
    ]);
    expect(deleted.filesMarkedInactive).toBe(1);
    expect(deleted.files?.[0]?.status).toBe("updated");
    const targetAfter = await store.getDocument("notes", "opaque.md");
    expect(targetAfter.ok && targetAfter.value?.active).toBe(false);
  });

  test("large graph reconciliation yields to unrelated event-loop work", async () => {
    const collection: Collection = {
      name: "notes",
      path: tempDir,
      pattern: "**/*.md",
      include: [],
      exclude: [],
    };
    await store.syncCollections([collection]);
    for (let index = 0; index < 60; index += 1) {
      const mirrorHash = `yield-mirror-${index}`;
      await store.upsertDocument({
        collection: "notes",
        relPath: `yield-${index}.md`,
        sourceHash: `yield-source-${index}`,
        sourceMime: "text/markdown",
        sourceExt: ".md",
        sourceSize: 20,
        sourceMtime: "2026-07-21T00:00:00Z",
        mirrorHash,
      });
      await store.upsertContent(mirrorHash, `# Yield ${index}\n`);
    }

    let unrelatedWorkCompleted = false;
    setTimeout(() => {
      unrelatedWorkCompleted = true;
    }, 0);
    const errors = await new SyncService().reconcileTypedEdges(store);

    expect(errors).toEqual([]);
    expect(unrelatedWorkCompleted).toBe(true);
  });
});
