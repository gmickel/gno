/**
 * Root-wide listActiveSourcePaths store seam for watcher fallback (gno-27.2).
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DocumentInput } from "../../src/store/types";

import { SqliteAdapter, WATCHER_ACTIVE_SOURCE_PATH_MAX } from "../../src/store";
import { safeRm } from "../helpers/cleanup";

if (process.platform === "win32") {
  setDefaultTimeout(15_000);
}

const TEST_MAX = WATCHER_ACTIVE_SOURCE_PATH_MAX;

function doc(
  overrides: Partial<DocumentInput> & { relPath: string }
): DocumentInput {
  return {
    collection: "notes",
    sourceHash: `hash_${overrides.collection ?? "notes"}_${overrides.relPath}`,
    sourceMime: "text/markdown",
    sourceExt: ".md",
    sourceSize: 100,
    sourceMtime: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("listActiveSourcePaths", () => {
  let adapter: SqliteAdapter;
  let testDir = "";

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "gno-watcher-root-src-"));
    adapter = new SqliteAdapter();
    await adapter.open(join(testDir, "test.sqlite"), "unicode61");
    await adapter.syncCollections([
      {
        name: "notes",
        path: "/notes",
        pattern: "**/*",
        include: [],
        exclude: [],
      },
      {
        name: "other",
        path: "/other",
        pattern: "**/*",
        include: [],
        exclude: [],
      },
    ]);
  });

  afterEach(async () => {
    await adapter.close();
    await safeRm(testDir);
  });

  test("returns unique ordered active sources within budget (5000)", async () => {
    const expected: string[] = [];
    for (let i = 0; i < 5000; i += 1) {
      const rel = `n${String(i).padStart(4, "0")}.md`;
      expected.push(rel);
      await adapter.upsertDocument(doc({ relPath: rel }));
    }
    const result = await adapter.listActiveSourcePaths("notes", 5000);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    expect(result.value).toEqual(expected);
  });

  test("excludes inactive rows and other collections", async () => {
    await adapter.upsertDocument(doc({ relPath: "keep.md" }));
    await adapter.upsertDocument(doc({ relPath: "gone.md" }));
    await adapter.upsertDocument(
      doc({ collection: "other", relPath: "elsewhere.md" })
    );
    expect((await adapter.markInactive("notes", ["gone.md"])).ok).toBe(true);

    const result = await adapter.listActiveSourcePaths("notes", TEST_MAX);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(["keep.md"]);
    }
  });

  test("many logical record docs collapse to one physical source", async () => {
    for (let i = 0; i < 20; i += 1) {
      await adapter.upsertDocument(
        doc({
          relPath: `.gno/records/h/rec-${i}.md`,
          recordSourcePath: "export.jsonl",
          recordKey: `k${i}`,
        })
      );
    }
    await adapter.upsertDocument(doc({ relPath: "plain.md" }));

    const result = await adapter.listActiveSourcePaths("notes", TEST_MAX);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(["export.jsonl", "plain.md"]);
    }

    // Overflow is on distinct sources, not logical rows: 21 logical / 2 sources.
    const tight = await adapter.listActiveSourcePaths("notes", 1);
    expect(tight.ok).toBe(false);
    if (!tight.ok) {
      expect(tight.error.code).toBe("OVERFLOW");
    }
  });

  test("max+1 overflow never truncates success", async () => {
    await adapter.upsertDocument(doc({ relPath: "a.md" }));
    await adapter.upsertDocument(doc({ relPath: "b.md" }));
    await adapter.upsertDocument(doc({ relPath: "c.md" }));

    const overflow = await adapter.listActiveSourcePaths("notes", 2);
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) {
      expect(overflow.error.code).toBe("OVERFLOW");
      expect("value" in overflow).toBe(false);
    }

    const okAtMax = await adapter.listActiveSourcePaths("notes", 3);
    expect(okAtMax.ok).toBe(true);
    if (okAtMax.ok) {
      expect(okAtMax.value).toEqual(["a.md", "b.md", "c.md"]);
    }
  });
});
