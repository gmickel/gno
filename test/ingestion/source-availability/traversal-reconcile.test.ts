/**
 * Full traversal + reconciliation: dataless prefixes are not enumerated and
 * previously indexed descendants stay active.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
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
import type { WalkConfig, WalkerPort } from "../../../src/ingestion/types";

import { SyncService } from "../../../src/ingestion/sync";
import { FileWalker } from "../../../src/ingestion/walker";
import { SqliteAdapter } from "../../../src/store/sqlite/adapter";
import { safeRm } from "../../helpers/cleanup";

function fixedReader(
  mode: SourceAvailabilityMode,
  result: SourceReadResult
): SourceContentReaderPort {
  return {
    mode,
    readAll: async () => result,
  };
}

function mapClassifier(
  mode: SourceAvailabilityMode,
  byRel: Record<string, DirectoryAvailabilityResult>,
  rootAbs: string
): DirectoryAvailabilityPort {
  const rootPrefix = rootAbs.endsWith("/") ? rootAbs.slice(0, -1) : rootAbs;
  const classify = (absPath: string): DirectoryAvailabilityResult => {
    const normalized = absPath.endsWith("/") ? absPath.slice(0, -1) : absPath;
    if (normalized === rootPrefix) {
      return byRel[""] ?? { kind: "available" };
    }
    let rel: string | null = null;
    if (normalized.startsWith(`${rootPrefix}/`)) {
      rel = normalized.slice(rootPrefix.length + 1);
    } else {
      // Tolerate /var vs /private/var realpath drift in fixtures.
      const marker = "/docs/";
      const idx = normalized.lastIndexOf(marker);
      if (idx >= 0) {
        rel = normalized.slice(idx + marker.length);
      }
    }
    if (rel === null || rel === "") {
      return byRel[""] ?? { kind: "available" };
    }
    return byRel[rel] ?? { kind: "available" as const };
  };
  return {
    mode,
    classify: async (absPath: string) => classify(absPath),
    readDirectory: (absPath, read) => {
      const classified = classify(absPath);
      return classified.kind === "available"
        ? { kind: "available", value: read() }
        : classified;
    },
  };
}

describe("local-mode full traversal", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gno-walk-avail-"));
    await mkdir(join(tmpDir, "docs"), { recursive: true });
  });

  afterEach(async () => {
    await safeRm(tmpDir);
  });

  test("dataless directory is not enumerated; sibling files remain eligible", async () => {
    const root = await realpath(join(tmpDir, "docs"));
    await mkdir(join(root, "cloud", "nested"), { recursive: true });
    await mkdir(join(root, "local"), { recursive: true });
    await writeFile(join(root, "cloud", "nested", "hidden.md"), "# hidden\n");
    await writeFile(join(root, "local", "visible.md"), "# visible\n");

    const classifier = mapClassifier(
      "local",
      {
        "": { kind: "available" },
        cloud: {
          kind: "dataless",
          code: "DATALESS_DIRECTORY",
          message: "dataless",
        },
        local: { kind: "available" },
      },
      root
    );

    const walker = new FileWalker();
    const result = await walker.walk({
      root,
      pattern: "**/*.md",
      include: [],
      exclude: [],
      maxBytes: 1_000_000,
      sourceAvailability: "local",
      directoryAvailability: classifier,
    });

    expect(result.entries.map((e) => e.relPath)).toEqual(["local/visible.md"]);
    expect(
      result.skipped.some(
        (s) =>
          s.relPath === "cloud" &&
          s.reason === "DATALESS_DIRECTORY" &&
          s.unprovenPrefix === true
      )
    ).toBe(true);
    expect(result.entries.some((e) => e.relPath.includes("hidden"))).toBe(
      false
    );
  });

  test("availability change before root enumeration returns an unproven prefix", async () => {
    const root = await realpath(join(tmpDir, "docs"));
    let reads = 0;
    const classifier: DirectoryAvailabilityPort = {
      mode: "local",
      classify: async () => ({ kind: "available" }),
      readDirectory: () => ({
        kind: "dataless",
        code: "DATALESS_DIRECTORY",
        message: "became dataless before enumeration",
      }),
    };

    const result = await new FileWalker().walk({
      root,
      pattern: "**/*.md",
      include: [],
      exclude: [],
      maxBytes: 1_000_000,
      sourceAvailability: "local",
      directoryAvailability: {
        ...classifier,
        readDirectory: (absPath, read) => {
          reads += 1;
          return classifier.readDirectory(absPath, read);
        },
      },
    });

    expect(reads).toBe(1);
    expect(result.entries).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        relPath: "",
        reason: "DATALESS_DIRECTORY",
        unprovenPrefix: true,
      }),
    ]);
  });

  test("unresolvable local root is an unproven prefix, not an empty inventory", async () => {
    const missingRoot = join(tmpDir, "missing");
    const walker = new FileWalker();
    const result = await walker.walk({
      root: missingRoot,
      pattern: "**/*.md",
      include: [],
      exclude: [],
      maxBytes: 1_000_000,
      sourceAvailability: "local",
      directoryAvailability: mapClassifier(
        "local",
        { "": { kind: "available" } },
        missingRoot
      ),
    });

    expect(result.entries).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        relPath: "",
        reason: "SOURCE_AVAILABILITY_UNKNOWN",
        unprovenPrefix: true,
      }),
    ]);
  });

  test("any mode still uses glob and ignores directory classifier refusal", async () => {
    const root = join(tmpDir, "docs");
    await mkdir(join(root, "cloud"), { recursive: true });
    await writeFile(join(root, "cloud", "a.md"), "# a\n");

    const refusing: DirectoryAvailabilityPort = {
      mode: "local",
      classify: async () => ({
        kind: "dataless",
        code: "DATALESS_DIRECTORY",
        message: "should not apply in any mode",
      }),
      readDirectory: () => ({
        kind: "dataless",
        code: "DATALESS_DIRECTORY",
        message: "should not apply in any mode",
      }),
    };

    const walker = new FileWalker();
    const result = await walker.walk({
      root,
      pattern: "**/*.md",
      include: [],
      exclude: [],
      maxBytes: 1_000_000,
      sourceAvailability: "any",
      directoryAvailability: refusing,
    });
    expect(result.entries.map((e) => e.relPath)).toEqual(["cloud/a.md"]);
  });
});

describe("reconciliation preserves unproven prefixes", () => {
  let tmpDir: string;
  let collectionDir: string;
  let adapter: SqliteAdapter;
  let collection: Collection;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "gno-sync-prefix-"));
    collectionDir = join(tmpDir, "docs");
    await mkdir(join(collectionDir, "cloud", "nested"), { recursive: true });
    await mkdir(join(collectionDir, "local"), { recursive: true });
    await writeFile(
      join(collectionDir, "cloud", "nested", "kept.md"),
      "# kept\n"
    );
    await writeFile(join(collectionDir, "local", "ok.md"), "# ok\n");

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

    // Seed index with both files under any mode.
    const seed = new SyncService();
    const seeded = await seed.syncCollection(collection, adapter);
    expect(seeded.filesErrored).toBe(0);
    expect(
      seeded.filesAdded + seeded.filesUpdated + seeded.filesUnchanged
    ).toBe(2);
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(tmpDir);
  });

  test("dataless prefix preserves previously indexed descendant", async () => {
    const classifier = mapClassifier(
      "local",
      {
        "": { kind: "available" },
        cloud: {
          kind: "dataless",
          code: "DATALESS_DIRECTORY",
          message: "dataless cloud",
        },
        local: { kind: "available" },
      },
      collectionDir
    );

    // Walker double: local visible only; cloud prefix skipped as unproven.
    const walker: WalkerPort = {
      walk: async (_config: WalkConfig) => ({
        entries: [
          {
            absPath: join(collectionDir, "local", "ok.md"),
            relPath: "local/ok.md",
            size: 5,
            mtime: new Date().toISOString(),
            ctime: new Date().toISOString(),
          },
        ],
        skipped: [
          {
            absPath: join(collectionDir, "cloud"),
            relPath: "cloud",
            reason: "DATALESS_DIRECTORY",
            unprovenPrefix: true,
            message: "dataless cloud",
          },
        ],
      }),
    };

    const localCollection: Collection = {
      ...collection,
      sourceAvailability: "local",
    };
    const syncService = new SyncService(
      walker,
      undefined,
      undefined,
      undefined,
      () =>
        fixedReader("local", {
          ok: true,
          bytes: new TextEncoder().encode("# ok\n"),
        }),
      () => classifier
    );

    const result = await syncService.syncCollection(localCollection, adapter, {
      sourceAvailability: "local",
    });

    expect(result.filesMarkedInactive).toBe(0);
    expect(result.errors.some((e) => e.code === "DATALESS_DIRECTORY")).toBe(
      true
    );
    expect(result.filesSkipped).toBe(1);
    expect(
      result.files?.some(
        (f) => f.errorCode === "DATALESS_DIRECTORY" && f.status === "skipped"
      )
    ).toBe(true);

    const kept = await adapter.getDocument("docs", "cloud/nested/kept.md");
    expect(kept.ok && kept.value?.active).toBe(true);
    const ok = await adapter.getDocument("docs", "local/ok.md");
    expect(ok.ok && ok.value?.active).toBe(true);
  });

  test("new exclusion overrides dataless preservation and inactivates descendants", async () => {
    const classifier = mapClassifier(
      "local",
      {
        "": { kind: "available" },
        cloud: {
          kind: "dataless",
          code: "DATALESS_DIRECTORY",
          message: "dataless cloud",
        },
        local: { kind: "available" },
      },
      collectionDir
    );
    const syncService = new SyncService(
      new FileWalker(),
      undefined,
      undefined,
      undefined,
      () =>
        fixedReader("local", {
          ok: true,
          bytes: new TextEncoder().encode("# ok\n"),
        }),
      () => classifier
    );

    const result = await syncService.syncCollection(
      {
        ...collection,
        exclude: ["cloud/**"],
        sourceAvailability: "local",
      },
      adapter,
      { sourceAvailability: "local" }
    );

    expect(result.filesMarkedInactive).toBe(1);
    expect(result.errors.some((e) => e.code === "DATALESS_DIRECTORY")).toBe(
      false
    );
    const excluded = await adapter.getDocument("docs", "cloud/nested/kept.md");
    expect(excluded.ok && excluded.value?.active).toBe(false);
    const included = await adapter.getDocument("docs", "local/ok.md");
    expect(included.ok && included.value?.active).toBe(true);
  });
});
