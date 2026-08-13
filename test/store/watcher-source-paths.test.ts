/**
 * Active source-path store seams for watcher fallback reconciliation (gno-27.1).
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

/** Generous bound for non-overflow contract tests. */
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

describe("listActiveDirectChildSourcePaths", () => {
  let adapter: SqliteAdapter;
  let testDir = "";

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "gno-watcher-src-"));
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

  async function expectDirect(
    collection: string,
    dirRelPath: string,
    max = TEST_MAX
  ): Promise<string[]> {
    const result = await adapter.listActiveDirectChildSourcePaths(
      collection,
      dirRelPath,
      max
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.value;
  }

  test("returns active direct children of the collection root in deterministic order", async () => {
    await adapter.upsertDocument(doc({ relPath: "zeta.md" }));
    await adapter.upsertDocument(doc({ relPath: "alpha.md" }));
    await adapter.upsertDocument(doc({ relPath: "sub/nested.md" }));

    expect(await expectDirect("notes", "")).toEqual(["alpha.md", "zeta.md"]);
  });

  test("returns active direct children of a nested directory only", async () => {
    await adapter.upsertDocument(doc({ relPath: "a/one.md" }));
    await adapter.upsertDocument(doc({ relPath: "a/two.md" }));
    await adapter.upsertDocument(doc({ relPath: "a/deep/three.md" }));
    await adapter.upsertDocument(doc({ relPath: "root.md" }));

    expect(await expectDirect("notes", "a")).toEqual(["a/one.md", "a/two.md"]);
    expect(await expectDirect("notes", "a/deep")).toEqual(["a/deep/three.md"]);
  });

  test("excludes deeper descendants, inactive rows, and other collections", async () => {
    await adapter.upsertDocument(doc({ relPath: "a/keep.md" }));
    await adapter.upsertDocument(doc({ relPath: "a/gone.md" }));
    await adapter.upsertDocument(doc({ relPath: "a/deep/skip.md" }));
    await adapter.upsertDocument(
      doc({ collection: "other", relPath: "a/foreign.md" })
    );
    expect((await adapter.markInactive("notes", ["a/gone.md"])).ok).toBe(true);

    expect(await expectDirect("notes", "a")).toEqual(["a/keep.md"]);
    expect(await expectDirect("notes", "a", TEST_MAX)).toEqual(["a/keep.md"]);
    expect(await expectDirect("other", "a")).toEqual(["a/foreign.md"]);
  });

  test("normalizes separators, trailing slashes, and '.'", async () => {
    await adapter.upsertDocument(doc({ relPath: "a/b/note.md" }));
    await adapter.upsertDocument(doc({ relPath: "root.md" }));

    expect(await expectDirect("notes", "a/b/")).toEqual(["a/b/note.md"]);
    expect(await expectDirect("notes", "a\\b")).toEqual(["a/b/note.md"]);
    expect(await expectDirect("notes", "./a/b")).toEqual(["a/b/note.md"]);
    expect(await expectDirect("notes", ".")).toEqual(["root.md"]);
  });

  test("rejects directory arguments that escape the collection root", async () => {
    for (const dir of ["..", "../outside", "a/../..", "/etc"]) {
      const result = await adapter.listActiveDirectChildSourcePaths(
        "notes",
        dir,
        TEST_MAX
      );
      expect(result.ok).toBe(false);
      if (result.ok) {
        continue;
      }
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });

  test("rejects non-positive max", async () => {
    for (const max of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await adapter.listActiveDirectChildSourcePaths(
        "notes",
        "",
        max
      );
      expect(result.ok).toBe(false);
      if (result.ok) {
        continue;
      }
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });

  test("empty successful result is distinct from query failure", async () => {
    const empty = await adapter.listActiveDirectChildSourcePaths(
      "notes",
      "nothing/here",
      TEST_MAX
    );
    expect(empty.ok).toBe(true);
    if (empty.ok) {
      expect(empty.value).toEqual([]);
    }

    await adapter.close();
    const failed = await adapter.listActiveDirectChildSourcePaths(
      "notes",
      "",
      TEST_MAX
    );
    expect(failed.ok).toBe(false);
    if (failed.ok) {
      return;
    }
    expect(failed.error.code).toBe("QUERY_FAILED");
  });

  test("record containers collapse to their physical source path", async () => {
    const container = (relPath: string, key: string, sourcePath: string) =>
      doc({
        relPath,
        sourceExt: ".jsonl",
        sourceMime: "application/jsonl",
        recordKey: key,
        recordSourcePath: sourcePath,
      });

    await adapter.upsertDocument(
      container(".gno/records/hash/one.md", "one", "a/export.jsonl")
    );
    await adapter.upsertDocument(
      container(".gno/records/hash/two.md", "two", "a/export.jsonl")
    );
    await adapter.upsertDocument(doc({ relPath: "a/plain.md" }));

    expect(await expectDirect("notes", "a")).toEqual([
      "a/export.jsonl",
      "a/plain.md",
    ]);
    expect(await expectDirect("notes", ".gno/records/hash")).toEqual([]);
  });

  test("overflow when unique matching sources exceed max; never truncates success", async () => {
    const max = 3;
    for (let i = 0; i < max + 2; i += 1) {
      await adapter.upsertDocument(
        doc({ relPath: `n${String(i).padStart(2, "0")}.md` })
      );
    }

    const overflow = await adapter.listActiveDirectChildSourcePaths(
      "notes",
      "",
      max
    );
    expect(overflow.ok).toBe(false);
    if (overflow.ok) {
      return;
    }
    expect(overflow.error.code).toBe("OVERFLOW");
    // No successful truncated list — error only.
    expect("value" in overflow).toBe(false);

    // Exactly max unique sources succeeds.
    const okAtMax = await adapter.listActiveDirectChildSourcePaths(
      "notes",
      "",
      max + 2
    );
    expect(okAtMax.ok).toBe(true);
    if (okAtMax.ok) {
      expect(okAtMax.value).toEqual([
        "n00.md",
        "n01.md",
        "n02.md",
        "n03.md",
        "n04.md",
      ]);
    }
  });
});

describe("listActiveDescendantSourcePaths", () => {
  let adapter: SqliteAdapter;
  let testDir = "";

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "gno-watcher-desc-"));
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

  async function expectDescendants(
    collection: string,
    dirRelPath: string,
    max = TEST_MAX
  ): Promise<string[]> {
    const result = await adapter.listActiveDescendantSourcePaths(
      collection,
      dirRelPath,
      max
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.value;
  }

  test("returns direct children and deeper descendants in deterministic order", async () => {
    await adapter.upsertDocument(doc({ relPath: "dir1/a.md" }));
    await adapter.upsertDocument(doc({ relPath: "dir1/sub/c.md" }));
    await adapter.upsertDocument(doc({ relPath: "dir1/sub/deeper/d.md" }));
    await adapter.upsertDocument(doc({ relPath: "root.md" }));

    expect(await expectDescendants("notes", "dir1")).toEqual([
      "dir1/a.md",
      "dir1/sub/c.md",
      "dir1/sub/deeper/d.md",
    ]);
    expect(await expectDescendants("notes", "dir1/sub")).toEqual([
      "dir1/sub/c.md",
      "dir1/sub/deeper/d.md",
    ]);
  });

  test("prefix-sharing sibling directories are never swept in", async () => {
    await adapter.upsertDocument(doc({ relPath: "dir1/a.md" }));
    await adapter.upsertDocument(doc({ relPath: "dir10/x.md" }));
    await adapter.upsertDocument(doc({ relPath: "dir1-notes/y.md" }));
    await adapter.upsertDocument(doc({ relPath: "dir1.bak/z.md" }));

    expect(await expectDescendants("notes", "dir1")).toEqual(["dir1/a.md"]);
    expect(await expectDescendants("notes", "dir10")).toEqual(["dir10/x.md"]);
  });

  test("excludes inactive rows and other collections", async () => {
    await adapter.upsertDocument(doc({ relPath: "dir1/keep.md" }));
    await adapter.upsertDocument(doc({ relPath: "dir1/sub/gone.md" }));
    await adapter.upsertDocument(
      doc({ collection: "other", relPath: "dir1/elsewhere.md" })
    );
    expect((await adapter.markInactive("notes", ["dir1/sub/gone.md"])).ok).toBe(
      true
    );

    expect(await expectDescendants("notes", "dir1")).toEqual(["dir1/keep.md"]);
  });

  test("resolves record-backed documents through their physical source path", async () => {
    await adapter.upsertDocument(
      doc({
        relPath: ".gno/records/h/one.md",
        recordSourcePath: "dir1/export.jsonl",
        recordKey: "one",
      })
    );
    await adapter.upsertDocument(
      doc({
        relPath: ".gno/records/h/two.md",
        recordSourcePath: "dir1/export.jsonl",
        recordKey: "two",
      })
    );
    await adapter.upsertDocument(doc({ relPath: "dir1/sub/plain.md" }));

    expect(await expectDescendants("notes", "dir1")).toEqual([
      "dir1/export.jsonl",
      "dir1/sub/plain.md",
    ]);
  });

  test("rejects the collection root and escaping paths; empty ok is not failure", async () => {
    const root = await adapter.listActiveDescendantSourcePaths(
      "notes",
      "",
      TEST_MAX
    );
    expect(root.ok).toBe(false);
    expect(root.ok ? "" : root.error.code).toBe("INVALID_INPUT");

    const escape = await adapter.listActiveDescendantSourcePaths(
      "notes",
      "../outside",
      TEST_MAX
    );
    expect(escape.ok).toBe(false);
    expect(escape.ok ? "" : escape.error.code).toBe("INVALID_INPUT");

    const empty = await adapter.listActiveDescendantSourcePaths(
      "notes",
      "missing",
      TEST_MAX
    );
    expect(empty.ok).toBe(true);
    if (empty.ok) {
      expect(empty.value).toEqual([]);
    }

    await adapter.close();
    const failed = await adapter.listActiveDescendantSourcePaths(
      "notes",
      "dir1",
      TEST_MAX
    );
    expect(failed.ok).toBe(false);
    if (failed.ok) {
      return;
    }
    expect(failed.error.code).toBe("QUERY_FAILED");
  });

  test("rejects non-positive max", async () => {
    for (const max of [0, -1, 2.2, Number.NaN]) {
      const result = await adapter.listActiveDescendantSourcePaths(
        "notes",
        "dir1",
        max
      );
      expect(result.ok).toBe(false);
      if (result.ok) {
        continue;
      }
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });

  test("overflow when unique matching descendants exceed max; never truncates success", async () => {
    const max = 2;
    await adapter.upsertDocument(doc({ relPath: "dir1/a.md" }));
    await adapter.upsertDocument(doc({ relPath: "dir1/b.md" }));
    await adapter.upsertDocument(doc({ relPath: "dir1/sub/c.md" }));
    await adapter.upsertDocument(doc({ relPath: "dir1/sub/d.md" }));

    const overflow = await adapter.listActiveDescendantSourcePaths(
      "notes",
      "dir1",
      max
    );
    expect(overflow.ok).toBe(false);
    if (overflow.ok) {
      return;
    }
    expect(overflow.error.code).toBe("OVERFLOW");
    expect("value" in overflow).toBe(false);

    const exact = await adapter.listActiveDescendantSourcePaths(
      "notes",
      "dir1",
      4
    );
    expect(exact.ok).toBe(true);
    if (exact.ok) {
      expect(exact.value).toEqual([
        "dir1/a.md",
        "dir1/b.md",
        "dir1/sub/c.md",
        "dir1/sub/d.md",
      ]);
    }
  });
});
