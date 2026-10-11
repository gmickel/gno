import { afterEach, beforeEach, expect, test } from "bun:test";
// node:fs/promises for mkdir/mkdtemp/rename/chmod/unlink (filesystem structure ops)
import { chmod, mkdir, mkdtemp, rename, unlink } from "node:fs/promises";
// node:os provides the temporary root
import { tmpdir } from "node:os";
// node:path has no Bun path utilities
import { join } from "node:path";

import type { Collection } from "../../src/config/types";

import { formatSyncResultLines } from "../../src/cli/commands/shared";
import { SyncService } from "../../src/ingestion";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

let tempDir: string;
let root: string;
let store: SqliteAdapter;
let collection: Collection;
const service = new SyncService();

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "gno-missing-root-"));
  root = join(tempDir, "drive");
  await mkdir(root);
  for (const index of [1, 2, 3])
    await Bun.write(
      join(root, `n${index}.md`),
      `# Note ${index}\n\nalpha bravo ${index}\n`
    );
  store = new SqliteAdapter();
  expect((await store.open(join(tempDir, "index.sqlite"), "porter")).ok).toBe(
    true
  );
  collection = {
    name: "drive",
    path: root,
    pattern: "**/*.md",
    include: [],
    exclude: [],
  };
  await store.syncCollections([collection]);
  await service.syncCollection(collection, store);
  expect(await hits()).toBe(3);
});

afterEach(async () => {
  await chmod(root, 0o755).catch(() => undefined);
  await store.close();
  await safeRm(tempDir);
});

async function hits(): Promise<number> {
  const result = await store.searchFts("alpha", { collection: "drive" });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.length;
}

test("a missing root keeps the collection searchable and says why", async () => {
  await rename(root, `${root}.offline`);
  const result = await service.syncCollection(collection, store);
  expect(result.filesMarkedInactive).toBe(0);
  expect(await hits()).toBe(3);
  const warning = result.errors.find(
    (error) => error.code === "SOURCE_AVAILABILITY_UNKNOWN"
  );
  expect(warning?.message).toContain("Collection root could not be resolved");
  expect(warning?.message).toContain(root);
  // The terminal summary names the collection and the reason without --verbose.
  const lines = formatSyncResultLines(
    {
      collections: [result],
      totalDurationMs: 0,
      totalFilesProcessed: 0,
      totalFilesAdded: 0,
      totalFilesUpdated: 0,
      totalFilesErrored: result.filesErrored,
      totalFilesSkipped: 0,
    },
    {}
  ).join("\n");
  expect(lines).toContain("drive:");
  expect(lines).toContain(warning!.message);

  // Cleanup while the root is unavailable keeps the retained documents.
  expect((await store.cleanupOrphans()).ok).toBe(true);
  expect(await hits()).toBe(3);

  // Back online: ordinary deletion semantics return.
  await rename(`${root}.offline`, root);
  await unlink(join(root, "n3.md"));
  const restored = await service.syncCollection(collection, store);
  expect(restored.filesMarkedInactive).toBe(1);
  expect(await hits()).toBe(2);
});

test("watcher-style path syncs keep documents while the root is missing", async () => {
  await rename(root, `${root}.offline`);
  const result = await service.syncPaths(collection, store, ["n1.md", "n2.md"]);
  expect(result.filesMarkedInactive).toBe(0);
  expect(result.files?.map((file) => file.status)).toEqual(["error", "error"]);
  expect(result.errors[0]).toMatchObject({
    relPath: "",
    code: "SOURCE_AVAILABILITY_UNKNOWN",
  });
  expect(result.errors[0]?.message).toContain(root);
  expect(await hits()).toBe(3);
});

test("a root that goes offline mid-batch keeps the rest", async () => {
  await unlink(join(root, "n3.md"));
  // Each path lists its record documents first; the drive drops right
  // before the second path is examined.
  const list = store.listRecordDocuments.bind(store);
  let calls = 0;
  store.listRecordDocuments = async (...args) => {
    calls += 1;
    if (calls === 2) await rename(root, `${root}.offline`);
    return list(...args);
  };
  const result = await service.syncPaths(collection, store, ["n3.md", "n1.md"]);
  expect(result.filesMarkedInactive).toBe(1);
  expect(result.files?.[1]?.errorCode).toBe("SOURCE_AVAILABILITY_UNKNOWN");
  expect(await hits()).toBe(2);
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "a root that cannot be listed keeps absent files",
  async () => {
    await unlink(join(root, "n1.md"));
    await chmod(root, 0o111);
    const result = await service.syncPaths(collection, store, ["n1.md"]);
    expect(result.filesMarkedInactive).toBe(0);
    expect(result.errors[0]?.message).toContain("EACCES");
    await chmod(root, 0o755);
    expect(await hits()).toBe(3);
  }
);

test("a root that exists but is empty still deletes", async () => {
  for (const index of [1, 2, 3]) await unlink(join(root, `n${index}.md`));
  const result = await service.syncCollection(collection, store);
  expect(result.filesMarkedInactive).toBe(3);
  expect(await hits()).toBe(0);
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "an unreadable root keeps documents",
  async () => {
    await chmod(root, 0o000);
    // The scan fails outright; nothing may be marked inactive either way.
    const marked = await service
      .syncCollection(collection, store)
      .then((result) => result.filesMarkedInactive)
      .catch(() => 0);
    expect(marked).toBe(0);
    expect(await hits()).toBe(3);
  }
);
