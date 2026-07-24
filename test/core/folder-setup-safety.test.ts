import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises provides temporary directory and filesystem structure APIs without Bun equivalents.
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
// node:os has no Bun temp-directory helper.
import { tmpdir } from "node:os";
// node:path has no Bun path utilities.
import { join } from "node:path";

import type { Collection, Config } from "../../src/config";

import {
  createDefaultConfig,
  DEFAULT_EXCLUDES,
  loadConfig,
  saveConfig,
} from "../../src/config";
import { setupFolder } from "../../src/core/folder-setup";
import { validateSetupOutputPaths } from "../../src/core/folder-setup-planning";
import {
  getSetupReceiptPath,
  persistSetupReceipt,
} from "../../src/core/setup-receipt";
import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

const FIXED_NOW = new Date("2026-07-24T10:00:00.000Z");
const tempRoots: string[] = [];

interface Harness {
  temp: string;
  folder: string;
  dataDir: string;
  configPath: string;
  store: SqliteAdapter;
}

function collection(
  name: string,
  path: string,
  exclude: string[] = [...DEFAULT_EXCLUDES]
): Collection {
  return {
    name,
    path,
    pattern: "**/*",
    include: [],
    exclude,
  };
}

async function createHarness(
  label: string,
  mutate?: (config: Config, temp: string) => Promise<void> | void
): Promise<Harness> {
  const temp = await mkdtemp(join(tmpdir(), `gno-setup-safety-${label}-`));
  tempRoots.push(temp);
  const folder = join(temp, "docs");
  const dataDir = join(temp, "data");
  const configPath = join(temp, "config", "index.yml");
  await Promise.all([
    mkdir(folder, { recursive: true }),
    mkdir(dataDir, { recursive: true }),
  ]);
  const config = createDefaultConfig();
  config.ftsTokenizer = "unicode61";
  await mutate?.(config, temp);
  const saved = await saveConfig(config, configPath);
  expect(saved.ok).toBe(true);
  const store = new SqliteAdapter();
  const opened = await store.open(
    join(dataDir, "index-default.sqlite"),
    "unicode61"
  );
  expect(opened.ok).toBe(true);
  return { temp, folder, dataDir, configPath, store };
}

function options(harness: Harness) {
  return {
    folder: harness.folder,
    store: harness.store,
    configPath: harness.configPath,
    dataDir: harness.dataDir,
    now: () => FIXED_NOW,
  };
}

afterEach(async () => {
  for (const path of tempRoots.splice(0)) {
    await safeRm(path);
  }
});

describe("verified folder setup safety boundaries", () => {
  test("hashes exact UTF-8 realpath bytes for the receipt filename", () => {
    const path = getSetupReceiptPath({
      dataDir: "/var/gno",
      indexName: "default",
      folderRealpath: "/tmp/folder",
    });
    expect(path).toBe(
      "/var/gno/setup-receipts/default/04bd648861b09d5058192fc6e12328a75f65478f1437b920d1ad871037f9af94.json"
    );
  });

  test("fails before receipt creation when the opened store identity disagrees", async () => {
    const harness = await createHarness("store-mismatch");
    try {
      await writeFile(join(harness.folder, "note.md"), "Store binding proof");
      const result = await setupFolder({
        ...options(harness),
        indexName: "other",
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "store_index_mismatch" },
        receipt: null,
      });
      const wrongReceipt = getSetupReceiptPath({
        dataDir: harness.dataDir,
        indexName: "other",
        folderRealpath: await realpath(harness.folder),
      });
      expect(await Bun.file(wrongReceipt).exists()).toBe(false);
    } finally {
      await harness.store.close();
    }
  });

  test("maps every receipt persistence boundary to a stable in-memory failure", async () => {
    for (let failedWrite = 1; failedWrite <= 10; failedWrite += 1) {
      const harness = await createHarness(`receipt-failure-${failedWrite}`);
      try {
        await writeFile(
          join(harness.folder, "note.md"),
          `Receipt failure proof ${failedWrite}`
        );
        let writes = 0;
        const result = await setupFolder({
          ...options(harness),
          receiptWriter: async (receipt) => {
            writes += 1;
            if (writes === failedWrite) {
              throw new Error("simulated write failure");
            }
            await persistSetupReceipt(receipt);
          },
        });
        expect(result).toMatchObject({
          ok: false,
          error: { code: "receipt_write_failed" },
          receipt: {
            status: "failed",
            failure: { code: "receipt_write_failed" },
          },
        });
        expect(writes).toBe(failedWrite);
        expect(result.receipt?.paths.receipt).toContain("/setup-receipts/");
      } finally {
        await harness.store.close();
      }
    }
  });

  test("rejects data, receipt, config, and store outputs nested under the source", async () => {
    const temp = await mkdtemp(join(tmpdir(), "gno-setup-safety-overlap-"));
    tempRoots.push(temp);
    const folder = join(temp, "source");
    const dataDir = join(folder, ".gno-data");
    const configPath = join(temp, "config", "index.yml");
    await mkdir(dataDir, { recursive: true });
    const saved = await saveConfig(createDefaultConfig(), configPath);
    expect(saved.ok).toBe(true);
    const store = new SqliteAdapter();
    const opened = await store.open(
      join(dataDir, "index-default.sqlite"),
      "snowball english"
    );
    expect(opened.ok).toBe(true);
    try {
      const result = await setupFolder({
        folder,
        store,
        configPath,
        dataDir,
        now: () => FIXED_NOW,
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "setup_path_overlap" },
        receipt: null,
      });
      const receipt = getSetupReceiptPath({
        dataDir,
        indexName: "default",
        folderRealpath: await realpath(folder),
      });
      expect(await Bun.file(receipt).exists()).toBe(false);
    } finally {
      await store.close();
    }
  });

  test("uses reused collection filters for preflight and ingestion", async () => {
    const harness = await createHarness("effective-filters", (config, temp) => {
      config.collections.push(
        collection("existing", join(temp, "docs"), [".env"])
      );
    });
    try {
      await writeFile(join(harness.folder, "note.md"), "Safe lexical proof");
      await writeFile(join(harness.folder, ".env"), "SECRET=value");
      const result = await setupFolder(options(harness));
      expect(result.ok).toBe(true);
      expect(result.receipt?.input.excludes).toEqual([".env"]);
      const documents = await harness.store.listDocuments("existing");
      expect(documents.ok).toBe(true);
      expect(documents.ok && documents.value.map((doc) => doc.uri)).toEqual([
        "gno://existing/note.md",
      ]);

      const disagreement = await setupFolder({
        ...options(harness),
        exclude: [],
      });
      expect(disagreement).toMatchObject({
        ok: false,
        error: { code: "collection_filter_disagreement" },
      });
    } finally {
      await harness.store.close();
    }
  });

  test("normalizes an explicit empty exclusion list identically on create and reuse", async () => {
    const harness = await createHarness("empty-excludes");
    try {
      await writeFile(join(harness.folder, "note.md"), "Default filter proof");
      const created = await setupFolder({
        ...options(harness),
        exclude: [],
      });
      expect(created.ok).toBe(true);
      expect(created.receipt?.input.excludes).toEqual(
        [...DEFAULT_EXCLUDES].sort()
      );
      const loaded = await loadConfig(harness.configPath);
      expect(loaded.ok).toBe(true);
      expect(
        loaded.ok && loaded.value.collections[0]?.exclude.slice().sort()
      ).toEqual([...DEFAULT_EXCLUDES].sort());

      const reused = await setupFolder({
        ...options(harness),
        exclude: [],
      });
      expect(reused.ok).toBe(true);
      expect(reused.receipt?.collection.disposition).toBe("reused");
      expect(reused.receipt?.input.excludes).toEqual(
        created.receipt?.input.excludes
      );
    } finally {
      await harness.store.close();
    }
  });

  test("resolves a symlinked deepest ancestor before appending missing output segments", async () => {
    const temp = await mkdtemp(join(tmpdir(), "gno-setup-safety-symlink-"));
    tempRoots.push(temp);
    const source = join(temp, "source");
    const outside = join(temp, "outside");
    await Promise.all([
      mkdir(source, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    const intoSource = join(outside, "into-source");
    await symlink(source, intoSource, "dir");
    const result = await validateSetupOutputPaths(source, [
      {
        label: "Deep generated output",
        path: join(intoSource, "missing", "deeper", "receipt.json"),
      },
    ]);
    expect(result).toMatchObject({ code: "setup_path_overlap" });
  });

  test("fresh serialized reuse projection preserves a concurrent created collection", async () => {
    const harness = await createHarness("fresh-reuse", (config, temp) => {
      config.collections.push(collection("existing", join(temp, "docs")));
    });
    const createdRoot = join(harness.temp, "created");
    await mkdir(createdRoot, { recursive: true });
    await writeFile(join(harness.folder, "existing.md"), "Existing root proof");
    await writeFile(join(createdRoot, "created.md"), "Created root proof");

    let signalReuseReady: () => void = () => undefined;
    let releaseReuse: () => void = () => undefined;
    const reuseReady = new Promise<void>((resolve) => {
      signalReuseReady = resolve;
    });
    const reuseRelease = new Promise<void>((resolve) => {
      releaseReuse = resolve;
    });
    try {
      const reusePromise = setupFolder({
        ...options(harness),
        beforeConfigBoundary: async () => {
          signalReuseReady();
          await reuseRelease;
        },
      });
      await reuseReady;
      const created = await setupFolder({
        ...options(harness),
        folder: createdRoot,
      });
      expect(created.ok).toBe(true);
      releaseReuse();
      const reused = await reusePromise;
      expect(reused.ok).toBe(true);

      const loaded = await loadConfig(harness.configPath);
      expect(loaded.ok).toBe(true);
      expect(
        loaded.ok && loaded.value.collections.map((item) => item.name).sort()
      ).toEqual(["created", "existing"]);
      const createdDocs = await harness.store.listDocuments("created");
      const existingDocs = await harness.store.listDocuments("existing");
      expect(createdDocs.ok && createdDocs.value).toHaveLength(1);
      expect(existingDocs.ok && existingDocs.value).toHaveLength(1);
    } finally {
      releaseReuse();
      await harness.store.close();
    }
  });
});
