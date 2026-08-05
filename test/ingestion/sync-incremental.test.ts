import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
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

  /**
   * The capture/API path, which reaches `syncPaths` through `syncFiles`.
   *
   * Every capture call site (`src/cli/commands/capture.ts`,
   * `src/mcp/tools/capture.ts`, and both `src/sdk/client.ts` sites) does the
   * same two things before syncing: `mkdir(dirname(absPath), {recursive:true})`
   * and then writes a REGULAR file. So no component of a captured path is ever
   * a symlink, and the no-follow policy `syncPaths` now enforces cannot touch
   * it. This pins that, because "shared ingestion got stricter" is exactly the
   * kind of change that silently breaks the write path.
   *
   * NOT discriminating against 0c517f7f - it passes there too, by construction.
   * It is a regression guard for the shared-ingestion change, not a bug pin.
   */
  test("a captured file in a nested real directory still syncs", async () => {
    const root = join(tempDir, "captures");
    const collection: Collection = {
      name: "captures",
      path: root,
      pattern: "**/*.md",
      include: [],
      exclude: [],
    };
    await mkdir(join(root, "inbox", "2026"), { recursive: true });
    await store.syncCollections([collection]);
    // Exactly what every capture call site does: mkdir -p, then write a file.
    await writeFile(join(root, "inbox", "2026", "note.md"), "# captured\n");

    const service = new SyncService();
    const results = await service.syncFiles(collection, store, [
      "inbox/2026/note.md",
    ]);

    expect(results[0]?.status).toBe("added");
    const document = await store.getDocument(
      collection.name,
      "inbox/2026/note.md"
    );
    expect(document.ok && document.value?.active).toBe(true);
  });

  /**
   * The other half of the same guarantee, and an intended behavior CHANGE.
   *
   * A file written under a symlinked directory inside the collection is one a
   * full `gno update` never indexes, so indexing it here only produced a
   * document that the next update deactivated. It is now refused up front, and
   * the receipt says `skipped` rather than reporting a success that does not
   * survive.
   *
   * DISCRIMINATING against 0c517f7f: there this indexes as `added` and the
   * document is active.
   */
  test("a file written under a symlinked directory is not indexed", async () => {
    const root = join(tempDir, "aliased");
    const collection: Collection = {
      name: "aliased",
      path: root,
      pattern: "**/*.md",
      include: [],
      exclude: [],
    };
    await mkdir(join(root, "real"), { recursive: true });
    await symlink(join(root, "real"), join(root, "alias"), "dir");
    await store.syncCollections([collection]);
    await writeFile(join(root, "real", "note.md"), "# aliased\n");

    const service = new SyncService();
    const results = await service.syncFiles(collection, store, [
      "alias/note.md",
    ]);

    expect(results[0]?.status).toBe("skipped");
    const document = await store.getDocument(collection.name, "alias/note.md");
    expect(document.ok && document.value).toBeNull();
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

  test("deactivates indexed documents when their directory becomes a regular file", async () => {
    const collectionDir = join(tempDir, "enotdir");
    await mkdir(join(collectionDir, "dir1"), { recursive: true });
    await writeFile(join(collectionDir, "dir1", "a.md"), "# Nested\n");
    const collection: Collection = {
      name: "notes",
      path: collectionDir,
      pattern: "**/*.md",
      include: [],
      exclude: [],
    };
    await store.syncCollections([collection]);
    const service = new SyncService();
    await service.syncCollection(collection, store);
    const before = await store.getDocument("notes", "dir1/a.md");
    expect(before.ok && before.value?.active).toBe(true);

    // Replace the indexed DIRECTORY with a regular file. `dir1/a.md` now stats
    // ENOTDIR, not ENOENT - a path component is not a directory. That is a
    // structural fact about the filesystem (the document is gone), not a
    // transient failure to observe it, so it must deactivate exactly like a
    // plain deletion. `listEligibleDirectChildren` already classifies ENOTDIR
    // as missing and hands these paths to `syncPaths`; when `syncPaths`
    // answered STAT_FAILED instead, the documents stayed active and searchable
    // with no way to ever retire them.
    await rm(join(collectionDir, "dir1"), { recursive: true, force: true });
    await writeFile(join(collectionDir, "dir1"), "not a directory\n");

    const result = await service.syncPaths(collection, store, ["dir1/a.md"]);

    expect(result.files?.[0]?.errorCode).toBeUndefined();
    expect(result.filesErrored).toBe(0);
    expect(result.filesMarkedInactive).toBe(1);
    const after = await store.getDocument("notes", "dir1/a.md");
    expect(after.ok && after.value?.active).toBe(false);
  });

  // Root ignores the permission bits this relies on, and Windows has no
  // equivalent, so the complement case is asserted where it is observable.
  test.skipIf(process.getuid?.() === 0 || process.platform === "win32")(
    "keeps a transient stat failure on the fail-closed path",
    async () => {
      const collectionDir = join(tempDir, "statfail");
      await mkdir(collectionDir, { recursive: true });
      await writeFile(join(collectionDir, "guarded.md"), "# Guarded\n");
      const collection: Collection = {
        name: "notes",
        path: collectionDir,
        pattern: "**/*.md",
        include: [],
        exclude: [],
      };
      await store.syncCollections([collection]);
      const service = new SyncService();
      await service.syncCollection(collection, store);

      // The complement of the ENOTDIR case: an errno that means "could not
      // observe" must never be read as "does not exist". A directory whose
      // execute bit is cleared makes `stat` fail EACCES while the file is very
      // much still there, so the document must stay active.
      await chmod(collectionDir, 0o000);
      let result: Awaited<ReturnType<typeof service.syncPaths>>;
      try {
        result = await service.syncPaths(collection, store, ["guarded.md"]);
      } finally {
        await chmod(collectionDir, 0o755);
      }

      expect(result.filesErrored).toBe(1);
      expect(result.files?.[0]?.errorCode).toBe("STAT_FAILED");
      expect(result.filesMarkedInactive).toBe(0);
      const after = await store.getDocument("notes", "guarded.md");
      expect(after.ok && after.value?.active).toBe(true);
    }
  );

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
