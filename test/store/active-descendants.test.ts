/**
 * Active-descendants store seam - the removed-subtree half of fn-114 (R3/R10/R11).
 *
 * The direct-children seam next door answers "what is indexed directly inside
 * this directory". That is the right question for a directory that still
 * exists. It is the wrong one for a directory that was recursively DELETED:
 * everything nested below the first level would stay active. These tests pin
 * the subtree answer, its prefix containment (`dir1` must never sweep in
 * `dir10`), and its query plan.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DocumentInput } from "../../src/store/types";

import { SqliteAdapter } from "../../src/store";
import {
  ACTIVE_DESCENDANT_SOURCE_PATHS_SQL,
  activeDescendantSourcePathParams,
  activeDescendantSourcePathsBatchSql,
  SOURCE_PARENT_INDEX_NAME,
} from "../../src/store/source-path-sql";
import { safeRm } from "../helpers/cleanup";

function doc(overrides: Partial<DocumentInput> & { relPath: string }) {
  return {
    collection: "notes",
    sourceHash: `hash_${overrides.collection ?? "notes"}_${overrides.relPath}`,
    sourceMime: "text/markdown",
    sourceExt: ".md",
    sourceSize: 100,
    sourceMtime: "2024-01-01T00:00:00Z",
    ...overrides,
  } satisfies DocumentInput;
}

describe("listActiveDescendantSourcePaths", () => {
  let adapter: SqliteAdapter;
  let testDir = "";

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "gno-active-descendants-"));
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

  async function expectPaths(
    collection: string,
    dirRelPath: string
  ): Promise<string[]> {
    const result = await adapter.listActiveDescendantSourcePaths(
      collection,
      dirRelPath
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return [...result.value].sort();
  }

  test("returns direct children AND deeper descendants", async () => {
    await adapter.upsertDocument(doc({ relPath: "dir1/a.md" }));
    await adapter.upsertDocument(doc({ relPath: "dir1/sub/c.md" }));
    await adapter.upsertDocument(doc({ relPath: "dir1/sub/deeper/d.md" }));
    await adapter.upsertDocument(doc({ relPath: "root.md" }));

    expect(await expectPaths("notes", "dir1")).toEqual([
      "dir1/a.md",
      "dir1/sub/c.md",
      "dir1/sub/deeper/d.md",
    ]);
    expect(await expectPaths("notes", "dir1/sub")).toEqual([
      "dir1/sub/c.md",
      "dir1/sub/deeper/d.md",
    ]);
  });

  test("a prefix-sharing sibling directory is never swept in", async () => {
    // The range bound alone (`>= 'dir1'`, `< 'dir10'`) spans names that merely
    // sort between the directory and its own children. Only the containment
    // predicate keeps them out - and a naive `LIKE 'dir1%'` would swallow
    // `dir10` outright.
    await adapter.upsertDocument(doc({ relPath: "dir1/a.md" }));
    await adapter.upsertDocument(doc({ relPath: "dir10/x.md" }));
    await adapter.upsertDocument(doc({ relPath: "dir1-notes/y.md" }));
    await adapter.upsertDocument(doc({ relPath: "dir1.bak/z.md" }));

    expect(await expectPaths("notes", "dir1")).toEqual(["dir1/a.md"]);
    expect(await expectPaths("notes", "dir10")).toEqual(["dir10/x.md"]);
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

    expect(await expectPaths("notes", "dir1")).toEqual(["dir1/keep.md"]);
  });

  test("resolves record-backed documents through their physical source path", async () => {
    // R10: a deleted JSONL container must deactivate every logical record it
    // produced, and those rows live under virtual `#record/...` paths.
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

    // One PHYSICAL path, de-duplicated, plus the nested plain document.
    expect(await expectPaths("notes", "dir1")).toEqual([
      "dir1/export.jsonl",
      "dir1/sub/plain.md",
    ]);
  });

  test("rejects the collection root and paths escaping it", async () => {
    const root = await adapter.listActiveDescendantSourcePaths("notes", "");
    expect(root.ok).toBe(false);
    expect(root.ok ? "" : root.error.code).toBe("INVALID_INPUT");

    const escape = await adapter.listActiveDescendantSourcePaths(
      "notes",
      "../outside"
    );
    expect(escape.ok).toBe(false);
    expect(escape.ok ? "" : escape.error.code).toBe("INVALID_INPUT");
  });

  /**
   * The removed-COLLECTION-ROOT answer. The subtree seam above rejects `""`
   * because a root prefix range has no bound, and the direct-children seam
   * answers only the root's own files - so a deleted collection directory left
   * every nested document active. This is the one seam that is deliberately
   * whole-collection, for the one condition that genuinely is.
   */
  describe("listActiveSourcePaths (removed collection root)", () => {
    test("returns every active document in the collection, at any depth", async () => {
      await adapter.upsertDocument(doc({ relPath: "top.md" }));
      await adapter.upsertDocument(doc({ relPath: "dir1/a.md" }));
      await adapter.upsertDocument(doc({ relPath: "dir1/sub/deeper/d.md" }));

      const result = await adapter.listActiveSourcePaths("notes");

      expect(result.ok).toBe(true);
      expect(result.ok ? [...result.value].sort() : []).toEqual([
        "dir1/a.md",
        "dir1/sub/deeper/d.md",
        "top.md",
      ]);
    });

    test("excludes inactive rows and other collections", async () => {
      await adapter.upsertDocument(doc({ relPath: "keep.md" }));
      await adapter.upsertDocument(doc({ relPath: "gone.md" }));
      await adapter.upsertDocument(
        doc({ collection: "other", relPath: "elsewhere.md" })
      );
      expect((await adapter.markInactive("notes", ["gone.md"])).ok).toBe(true);

      const result = await adapter.listActiveSourcePaths("notes");

      expect(result.ok ? result.value : []).toEqual(["keep.md"]);
    });

    test("resolves record-backed documents through their physical source path", async () => {
      // R10 holds here too: a removed root must deactivate the JSONL container
      // once, not each of its virtual record rows.
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

      const result = await adapter.listActiveSourcePaths("notes");

      expect(result.ok ? result.value : []).toEqual(["dir1/export.jsonl"]);
    });
  });

  describe("batched form", () => {
    test("answers every requested directory, empty when nothing is indexed", async () => {
      await adapter.upsertDocument(doc({ relPath: "dir1/a.md" }));
      await adapter.upsertDocument(doc({ relPath: "dir1/sub/c.md" }));

      const result = await adapter.listActiveDescendantSourcePathsBatch(
        "notes",
        ["dir1", "note.md.tmp", "dir1"]
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect([...(result.value.get("dir1") ?? [])].sort()).toEqual([
        "dir1/a.md",
        "dir1/sub/c.md",
      ]);
      // The discriminator's whole job: a dead temp name is "asked and empty",
      // never "never asked".
      expect(result.value.get("note.md.tmp")).toEqual([]);
      expect(result.value.size).toBe(2);
    });

    test("keeps prefix-sharing keys apart within one statement", async () => {
      await adapter.upsertDocument(doc({ relPath: "dir1/a.md" }));
      await adapter.upsertDocument(doc({ relPath: "dir10/x.md" }));

      const result = await adapter.listActiveDescendantSourcePathsBatch(
        "notes",
        ["dir1", "dir10"]
      );

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value.get("dir1")).toEqual(["dir1/a.md"]);
      expect(result.value.get("dir10")).toEqual(["dir10/x.md"]);
    });

    test("rejects the collection root for the whole call", async () => {
      const result = await adapter.listActiveDescendantSourcePathsBatch(
        "notes",
        ["dir1", ""]
      );

      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.error.code).toBe("INVALID_INPUT");
    });
  });

  describe("index coverage (R11)", () => {
    beforeEach(async () => {
      for (let index = 0; index < 400; index += 1) {
        await adapter.upsertDocument(doc({ relPath: `root-${index}.md` }));
        await adapter.upsertDocument(doc({ relPath: `a/nested-${index}.md` }));
        await adapter.upsertDocument(
          doc({ relPath: `a/deep/deeper-${index}.md` })
        );
        await adapter.upsertDocument(doc({ relPath: `a10/x-${index}.md` }));
      }
      adapter.getRawDb().exec("ANALYZE");
    });

    test("the subtree lookup is index-served with no scan and no temp b-tree", () => {
      const plan = adapter
        .getRawDb()
        .query<
          { detail: string },
          [string, string, string, string, number, string]
        >(`EXPLAIN QUERY PLAN ${ACTIVE_DESCENDANT_SOURCE_PATHS_SQL}`)
        .all(...activeDescendantSourcePathParams("notes", "a"))
        .map((row) => row.detail)
        .join("\n");

      expect(plan).toContain(
        `SEARCH documents USING INDEX ${SOURCE_PARENT_INDEX_NAME}`
      );
      expect(plan).not.toContain("SCAN documents");
      expect(plan).not.toContain("TEMP B-TREE");
    });

    test("the batched subtree lookup stays index-served at every key count", () => {
      for (const keyCount of [1, 2, 9, 26, 200]) {
        const keys = Array.from(
          { length: keyCount },
          (_, index) => `d${index}`
        );
        const plan = adapter
          .getRawDb()
          .query<{ detail: string }, string[]>(
            `EXPLAIN QUERY PLAN ${activeDescendantSourcePathsBatchSql(keys.length)}`
          )
          .all(...keys, "notes")
          .map((row) => row.detail)
          .join("\n");

        // Each key drives its OWN bounded range probe through the nested loop;
        // the only thing scanned is the constant key list itself.
        expect(plan).toContain(
          `SEARCH documents USING INDEX ${SOURCE_PARENT_INDEX_NAME}`
        );
        expect(plan).not.toContain("SCAN documents");
        expect(plan).not.toContain("TEMP B-TREE");
      }
    });

    test("results stay correct and bounded at scale", async () => {
      expect((await expectPaths("notes", "a")).length).toBe(800);
      expect((await expectPaths("notes", "a/deep")).length).toBe(400);
      expect((await expectPaths("notes", "a10")).length).toBe(400);
    });
  });
});
