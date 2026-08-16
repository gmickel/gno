/**
 * Targeted syncPaths must honor directory availability and preserve index
 * when absence under an unproven prefix cannot be proven.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Collection } from "../../../src/config/types";
import type {
  DirectoryAvailabilityPort,
  DirectoryAvailabilityResult,
  SourceAvailabilityMode,
  SourceContentReaderPort,
  SourceReadResult,
} from "../../../src/ingestion/source-availability";
import type { WalkerPort } from "../../../src/ingestion/types";

import { SyncService } from "../../../src/ingestion/sync";
import { SqliteAdapter } from "../../../src/store/sqlite/adapter";
import { safeRm } from "../../helpers/cleanup";

function fixedReader(
  mode: SourceAvailabilityMode,
  result: SourceReadResult
): SourceContentReaderPort {
  return { mode, readAll: async () => result };
}

function classifierFor(
  mode: SourceAvailabilityMode,
  decide: (absPath: string) => DirectoryAvailabilityResult
): DirectoryAvailabilityPort {
  return {
    mode,
    classify: async (absPath) => decide(absPath),
    readDirectory: (absPath, read) => {
      const classified = decide(absPath);
      return classified.kind === "available"
        ? { kind: "available", value: read() }
        : classified;
    },
  };
}

describe("syncPaths source-availability guards", () => {
  let tmpDir: string;
  let collectionDir: string;
  let adapter: SqliteAdapter;
  let collection: Collection;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gno-syncpaths-avail-"));
    collectionDir = join(tmpDir, "docs");
    await mkdir(join(collectionDir, "cloud"), { recursive: true });
    await writeFile(join(collectionDir, "cloud", "doc.md"), "# doc\n");
    await writeFile(join(collectionDir, "root.md"), "# root\n");

    adapter = new SqliteAdapter();
    expect((await adapter.open(join(tmpDir, "t.db"), "porter")).ok).toBe(true);

    collection = {
      name: "docs",
      path: collectionDir,
      pattern: "**/*.md",
      include: [],
      exclude: [],
      sourceAvailability: "any",
    };
    expect((await adapter.syncCollections([collection])).ok).toBe(true);
    const seed = new SyncService();
    await seed.syncCollection(collection, adapter);
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(tmpDir);
  });

  test("dataless ancestor skips targeted path without inactivation", async () => {
    await unlink(join(collectionDir, "cloud", "doc.md"));

    const noWalk: WalkerPort = {
      walk: async () => {
        throw new Error("syncPaths must not walk");
      },
    };
    const syncService = new SyncService(
      noWalk,
      undefined,
      undefined,
      undefined,
      () => {
        throw new Error("content reader must not run under dataless prefix");
      },
      () =>
        classifierFor("local", (absPath) => {
          if (
            absPath === join(collectionDir, "cloud") ||
            absPath.endsWith("/cloud")
          ) {
            return {
              kind: "dataless",
              code: "DATALESS_DIRECTORY",
              message: "dataless",
            };
          }
          return { kind: "available" };
        })
    );

    const localCollection: Collection = {
      ...collection,
      sourceAvailability: "local",
    };
    const result = await syncService.syncPaths(
      localCollection,
      adapter,
      ["cloud/doc.md"],
      { sourceAvailability: "local" }
    );

    expect(result.filesMarkedInactive).toBe(0);
    expect(result.files?.[0]?.status).toBe("skipped");
    expect(result.files?.[0]?.errorCode).toBe("DATALESS_DIRECTORY");

    const doc = await adapter.getDocument("docs", "cloud/doc.md");
    expect(doc.ok && doc.value?.active).toBe(true);
  });

  test("cloud placeholder on direct path is skipped via content boundary", async () => {
    const noWalk: WalkerPort = {
      walk: async () => {
        throw new Error("syncPaths must not walk");
      },
    };
    const syncService = new SyncService(
      noWalk,
      undefined,
      undefined,
      undefined,
      () =>
        fixedReader("local", {
          ok: false,
          code: "CLOUD_PLACEHOLDER",
          message: "refused",
          errno: 11,
        }),
      () => classifierFor("local", () => ({ kind: "available" }))
    );

    const result = await syncService.syncPaths(
      { ...collection, sourceAvailability: "local" },
      adapter,
      ["root.md"],
      { sourceAvailability: "local" }
    );
    expect(result.files?.[0]?.status).toBe("skipped");
    expect(result.files?.[0]?.errorCode).toBe("CLOUD_PLACEHOLDER");
    expect(result.filesErrored).toBe(0);
  });

  test("any mode still inactivates proven-absent targeted paths", async () => {
    await unlink(join(collectionDir, "cloud", "doc.md"));
    const noWalk: WalkerPort = {
      walk: async () => {
        throw new Error("syncPaths must not walk");
      },
    };
    const syncService = new SyncService(noWalk);
    const result = await syncService.syncPaths(collection, adapter, [
      "cloud/doc.md",
    ]);
    expect(result.filesMarkedInactive).toBe(1);
    const doc = await adapter.getDocument("docs", "cloud/doc.md");
    expect(doc.ok && doc.value?.active).toBe(false);
  });
});
