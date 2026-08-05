/**
 * Bounded active-direct-children store seam (fn-114 task .2, R3/R10/R11).
 */

import { Database } from "bun:sqlite";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";

// Windows SQLite file handles may not release immediately after close()
if (process.platform === "win32") {
  setDefaultTimeout(15_000);
}

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DocumentInput } from "../../src/store/types";

import {
  getSchemaVersion,
  migrations,
  runMigrations,
  SqliteAdapter,
} from "../../src/store";
import {
  ACTIVE_DIRECT_CHILD_BATCH_CHUNK,
  ACTIVE_DIRECT_CHILD_SOURCE_PATHS_SQL,
  activeDirectChildSourcePathsBatchSql,
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

describe("listActiveDirectChildSourcePaths", () => {
  let adapter: SqliteAdapter;
  let testDir = "";

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "gno-active-children-"));
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
    const result = await adapter.listActiveDirectChildSourcePaths(
      collection,
      dirRelPath
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return [...result.value].sort();
  }

  test("returns active direct children of the collection root", async () => {
    await adapter.upsertDocument(doc({ relPath: "root.md" }));
    await adapter.upsertDocument(doc({ relPath: "also-root.md" }));
    await adapter.upsertDocument(doc({ relPath: "sub/nested.md" }));

    expect(await expectPaths("notes", "")).toEqual(["also-root.md", "root.md"]);
  });

  test("returns active direct children of a nested directory", async () => {
    await adapter.upsertDocument(doc({ relPath: "a/one.md" }));
    await adapter.upsertDocument(doc({ relPath: "a/two.md" }));
    await adapter.upsertDocument(doc({ relPath: "a/deeper/three.md" }));
    await adapter.upsertDocument(doc({ relPath: "root.md" }));

    expect(await expectPaths("notes", "a")).toEqual(["a/one.md", "a/two.md"]);
    expect(await expectPaths("notes", "a/deeper")).toEqual([
      "a/deeper/three.md",
    ]);
  });

  test("excludes deeper descendants, inactive rows, and other collections", async () => {
    await adapter.upsertDocument(doc({ relPath: "a/keep.md" }));
    await adapter.upsertDocument(doc({ relPath: "a/gone.md" }));
    await adapter.upsertDocument(doc({ relPath: "a/deep/skip.md" }));
    await adapter.upsertDocument(
      doc({ collection: "other", relPath: "a/foreign.md" })
    );
    expect((await adapter.markInactive("notes", ["a/gone.md"])).ok).toBe(true);

    expect(await expectPaths("notes", "a")).toEqual(["a/keep.md"]);
    expect(await expectPaths("other", "a")).toEqual(["a/foreign.md"]);
  });

  test("normalizes separators, trailing slashes, and '.'", async () => {
    await adapter.upsertDocument(doc({ relPath: "a/b/note.md" }));
    await adapter.upsertDocument(doc({ relPath: "root.md" }));

    expect(await expectPaths("notes", "a/b/")).toEqual(["a/b/note.md"]);
    expect(await expectPaths("notes", "a\\b")).toEqual(["a/b/note.md"]);
    expect(await expectPaths("notes", "./a/b")).toEqual(["a/b/note.md"]);
    expect(await expectPaths("notes", ".")).toEqual(["root.md"]);
  });

  test("accepts a POSIX-legal drive-shaped directory name", async () => {
    // Pre-fix the unconditional drive-letter test refused this outright, so a
    // reconciliation under `a:notes` never saw its own children.
    if (process.platform === "win32") {
      return;
    }
    await adapter.upsertDocument(doc({ relPath: "a:notes/one.md" }));
    await adapter.upsertDocument(doc({ relPath: "a:notes/deep/two.md" }));

    expect(await expectPaths("notes", "a:notes")).toEqual(["a:notes/one.md"]);
  });

  test("rejects a directory argument that escapes the collection root", async () => {
    for (const dir of ["..", "../outside", "a/../..", "/etc"]) {
      const result = await adapter.listActiveDirectChildSourcePaths(
        "notes",
        dir
      );
      expect(result.ok).toBe(false);
      if (result.ok) {
        continue;
      }
      expect(result.error.code).toBe("INVALID_INPUT");
    }
  });

  test("returns an explicit non-throwing failure when the store is closed", async () => {
    await adapter.close();

    const result = await adapter.listActiveDirectChildSourcePaths("notes", "");

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("QUERY_FAILED");
  });

  test("returns an empty list for a directory with no active documents", async () => {
    expect(await expectPaths("notes", "nothing/here")).toEqual([]);
  });

  describe("record containers (R10)", () => {
    const container = (relPath: string, key: string, sourcePath: string) =>
      doc({
        relPath,
        sourceExt: ".jsonl",
        sourceMime: "application/jsonl",
        recordKey: key,
        recordSourcePath: sourcePath,
      });

    test("collapses several active logical records to one DISTINCT source path", async () => {
      await adapter.upsertDocument(
        container(".gno/records/hash/one.md", "one", "a/export.jsonl")
      );
      await adapter.upsertDocument(
        container(".gno/records/hash/two.md", "two", "a/export.jsonl")
      );
      await adapter.upsertDocument(
        container(".gno/records/hash/three.md", "three", "a/export.jsonl")
      );
      await adapter.upsertDocument(doc({ relPath: "a/plain.md" }));

      expect(await expectPaths("notes", "a")).toEqual([
        "a/export.jsonl",
        "a/plain.md",
      ]);
      // The virtual record path is never returned, and its own virtual
      // directory holds nothing.
      expect(await expectPaths("notes", ".gno/records/hash")).toEqual([]);
    });

    test("resolves a container stored directly in the collection root", async () => {
      await adapter.upsertDocument(
        container(".gno/records/rooth/one.md", "one", "export.jsonl")
      );

      expect(await expectPaths("notes", "")).toEqual(["export.jsonl"]);
    });

    test("drops the container once every logical record is inactive", async () => {
      await adapter.upsertDocument(
        container(".gno/records/hash/one.md", "one", "a/export.jsonl")
      );
      await adapter.upsertDocument(
        container(".gno/records/hash/two.md", "two", "a/export.jsonl")
      );

      expect(
        (await adapter.markInactive("notes", [".gno/records/hash/one.md"])).ok
      ).toBe(true);
      // One record still active - the container must still reconcile.
      expect(await expectPaths("notes", "a")).toEqual(["a/export.jsonl"]);

      expect(
        (await adapter.markInactive("notes", [".gno/records/hash/two.md"])).ok
      ).toBe(true);
      expect(await expectPaths("notes", "a")).toEqual([]);
    });

    test("tracks an atomically replaced container across its new record set", async () => {
      await adapter.upsertDocument(
        container(".gno/records/hash/old-one.md", "old-one", "a/export.jsonl")
      );
      await adapter.upsertDocument(
        container(".gno/records/hash/old-two.md", "old-two", "a/export.jsonl")
      );

      // Replacement: the old record set deactivates, a new one takes over the
      // same physical container path.
      expect(
        (
          await adapter.markInactive("notes", [
            ".gno/records/hash/old-one.md",
            ".gno/records/hash/old-two.md",
          ])
        ).ok
      ).toBe(true);
      await adapter.upsertDocument(
        container(".gno/records/hash/new-one.md", "new-one", "a/export.jsonl")
      );

      expect(await expectPaths("notes", "a")).toEqual(["a/export.jsonl"]);
    });
  });

  /**
   * Batched form (fn-114 task .3). The watcher uses it as a DISCRIMINATOR: at
   * queue time a dead temp name and a recursively deleted directory are both
   * just "a path that is gone", and only the indexed side separates them. That
   * question has to be affordable for every hint of a debounce window at once,
   * or the watcher is pushed back into capping - and dropping - hints.
   */
  describe("listActiveDirectChildSourcePathsBatch", () => {
    async function expectBatch(
      collection: string,
      dirRelPaths: string[]
    ): Promise<Map<string, string[]>> {
      const result = await adapter.listActiveDirectChildSourcePathsBatch(
        collection,
        dirRelPaths
      );
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return new Map(
        [...result.value].map(([dir, paths]) => [dir, [...paths].sort()])
      );
    }

    test("answers several directories in one call", async () => {
      await adapter.upsertDocument(doc({ relPath: "root.md" }));
      await adapter.upsertDocument(doc({ relPath: "a/one.md" }));
      await adapter.upsertDocument(doc({ relPath: "a/two.md" }));
      await adapter.upsertDocument(doc({ relPath: "b/three.md" }));
      await adapter.upsertDocument(doc({ relPath: "a/deep/skip.md" }));

      expect(await expectBatch("notes", ["", "a", "b"])).toEqual(
        new Map([
          ["", ["root.md"]],
          ["a", ["a/one.md", "a/two.md"]],
          ["b", ["b/three.md"]],
        ])
      );
    });

    test("returns an entry for every requested directory, empty when nothing is active", async () => {
      await adapter.upsertDocument(doc({ relPath: "a/keep.md" }));
      await adapter.upsertDocument(doc({ relPath: "a/gone.md" }));
      expect((await adapter.markInactive("notes", ["a/gone.md"])).ok).toBe(
        true
      );

      // "asked and empty" must be distinguishable from "never asked": the
      // watcher reads an empty answer as "this hint is a dead temp name", and
      // a missing key would make that indistinguishable from a lookup it
      // never performed.
      expect(
        await expectBatch("notes", ["a", "never-indexed", "note.md.tmp.7"])
      ).toEqual(
        new Map([
          ["a", ["a/keep.md"]],
          ["never-indexed", []],
          ["note.md.tmp.7", []],
        ])
      );
    });

    test("matches the single-directory seam for every shape it supports", async () => {
      await adapter.upsertDocument(doc({ relPath: "root.md" }));
      await adapter.upsertDocument(doc({ relPath: "a/b/note.md" }));
      await adapter.upsertDocument(
        doc({ collection: "other", relPath: "a/b/foreign.md" })
      );

      for (const dir of ["", ".", "a/b", "a/b/", "a\\b", "./a/b"]) {
        const single = await expectPaths("notes", dir);
        const batched = await expectBatch("notes", [dir]);
        expect([...batched.values()][0]).toEqual(single);
      }
    });

    test("collapses a record container's logical rows to one source path (R10)", async () => {
      const container = (relPath: string, key: string, sourcePath: string) =>
        doc({
          relPath,
          sourceExt: ".jsonl",
          sourceMime: "application/jsonl",
          recordKey: key,
          recordSourcePath: sourcePath,
        });
      await adapter.upsertDocument(
        container(".gno/records/h/one.md", "one", "a/export.jsonl")
      );
      await adapter.upsertDocument(
        container(".gno/records/h/two.md", "two", "a/export.jsonl")
      );
      await adapter.upsertDocument(
        container(".gno/records/h/three.md", "three", "a/export.jsonl")
      );

      // The batched statement drops DISTINCT to keep the plan index-served, so
      // the de-duplication has to happen here instead. Three logical records,
      // one physical container path.
      expect(await expectBatch("notes", ["a"])).toEqual(
        new Map([["a", ["a/export.jsonl"]]])
      );
    });

    test("de-duplicates repeated directory keys", async () => {
      await adapter.upsertDocument(doc({ relPath: "a/one.md" }));

      // `a` and `a/` normalize to the same key; the caller gets one entry.
      expect(await expectBatch("notes", ["a", "a/", "./a"])).toEqual(
        new Map([["a", ["a/one.md"]]])
      );
    });

    test("returns an empty map for an empty request", async () => {
      expect(await expectBatch("notes", [])).toEqual(new Map());
    });

    test("rejects the whole call when any directory escapes the collection root", async () => {
      const result = await adapter.listActiveDirectChildSourcePathsBatch(
        "notes",
        ["a", "../outside"]
      );

      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.error.code).toBe("INVALID_INPUT");
    });

    test("returns an explicit non-throwing failure when the store is closed", async () => {
      await adapter.close();

      const result = await adapter.listActiveDirectChildSourcePathsBatch(
        "notes",
        ["", "a"]
      );

      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.error.code).toBe("QUERY_FAILED");
    });

    test("answers more directories than fit in one statement", async () => {
      // Past the per-statement parameter chunk the lookup spans several
      // statements. Nothing may be dropped at the seam - that is precisely the
      // failure mode the batched discriminator exists to remove.
      const directories: string[] = [];
      for (
        let index = 0;
        index < ACTIVE_DIRECT_CHILD_BATCH_CHUNK + 5;
        index += 1
      ) {
        directories.push(`d${index}`);
        await adapter.upsertDocument(doc({ relPath: `d${index}/note.md` }));
      }

      const batched = await expectBatch("notes", directories);

      expect(batched.size).toBe(directories.length);
      expect(batched.get("d0")).toEqual(["d0/note.md"]);
      expect(batched.get(`d${ACTIVE_DIRECT_CHILD_BATCH_CHUNK + 4}`)).toEqual([
        `d${ACTIVE_DIRECT_CHILD_BATCH_CHUNK + 4}/note.md`,
      ]);
    });
  });

  describe("index coverage (R11)", () => {
    async function queryPlan(
      collection: string,
      parent: string
    ): Promise<string[]> {
      const db = adapter.getRawDb();
      return db
        .query<{ detail: string }, [string, string]>(
          `EXPLAIN QUERY PLAN ${ACTIVE_DIRECT_CHILD_SOURCE_PATHS_SQL}`
        )
        .all(collection, parent)
        .map((row) => row.detail);
    }

    function batchQueryPlan(collection: string, parents: string[]): string[] {
      const db = adapter.getRawDb();
      return db
        .query<{ detail: string }, string[]>(
          `EXPLAIN QUERY PLAN ${activeDirectChildSourcePathsBatchSql(parents.length)}`
        )
        .all(collection, ...parents)
        .map((row) => row.detail);
    }

    beforeEach(async () => {
      // Enough rows that SQLite would not prefer a scan for other reasons.
      for (let index = 0; index < 400; index += 1) {
        await adapter.upsertDocument(doc({ relPath: `root-${index}.md` }));
        await adapter.upsertDocument(doc({ relPath: `a/nested-${index}.md` }));
        await adapter.upsertDocument(
          doc({ relPath: `a/deep/deeper-${index}.md` })
        );
      }
      adapter.getRawDb().exec("ANALYZE");
    });

    test("migration created the parent index", () => {
      const indexes = adapter
        .getRawDb()
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'documents'"
        )
        .all()
        .map((row) => row.name);

      expect(indexes).toContain(SOURCE_PARENT_INDEX_NAME);
    });

    test("collection-root lookup is index-served with no temp b-tree", async () => {
      const plan = await queryPlan("notes", "");

      expect(plan.join("\n")).toContain(
        `SEARCH documents USING INDEX ${SOURCE_PARENT_INDEX_NAME}`
      );
      expect(plan.join("\n")).not.toContain("SCAN documents");
      expect(plan.join("\n")).not.toContain("TEMP B-TREE");
    });

    test("nested-directory lookup is index-served with no temp b-tree", async () => {
      const plan = await queryPlan("notes", "a");

      expect(plan.join("\n")).toContain(
        `SEARCH documents USING INDEX ${SOURCE_PARENT_INDEX_NAME}`
      );
      expect(plan.join("\n")).not.toContain("SCAN documents");
      expect(plan.join("\n")).not.toContain("TEMP B-TREE");
    });

    test("batched lookup stays index-served at every key count", () => {
      // R11 for the batched form. The `INDEXED BY` hint in the statement is
      // load-bearing rather than decorative: measured here, an UNHINTED
      // `IN (...)` list of 26 keys made SQLite switch to
      // `SEARCH documents USING INDEX idx_docs_wiki_relpath_resolve
      // (collection=?)` - a collection-wide probe that reads every active row
      // of the collection instead of one range per directory.
      for (const keyCount of [1, 2, 9, 26, 200]) {
        const parents = Array.from({ length: keyCount }, (_, index) =>
          index === 0 ? "" : `d${index}`
        );
        const plan = batchQueryPlan("notes", parents).join("\n");

        expect(plan).toContain(
          `SEARCH documents USING INDEX ${SOURCE_PARENT_INDEX_NAME}`
        );
        expect(plan).not.toContain("SCAN documents");
        expect(plan).not.toContain("TEMP B-TREE");
      }
    });

    test("batched lookup agrees with the single-directory lookup at scale", async () => {
      const batched = await adapter.listActiveDirectChildSourcePathsBatch(
        "notes",
        ["", "a", "a/deep"]
      );

      expect(batched.ok).toBe(true);
      if (!batched.ok) {
        return;
      }
      expect(batched.value.get("a")?.length).toBe(400);
      expect(batched.value.get("a/deep")?.length).toBe(400);
      expect([...(batched.value.get("a") ?? [])].sort()).toEqual(
        await expectPaths("notes", "a")
      );
    });

    test("an upgraded v25 database indexes its pre-existing rows", async () => {
      const upgradePath = join(testDir, "upgrade.sqlite");
      const db = new Database(upgradePath);
      try {
        expect(runMigrations(db, migrations.slice(0, 25), "unicode61").ok).toBe(
          true
        );
        expect(getSchemaVersion(db)).toBe(25);
        db.run(
          `INSERT INTO collections (name, path, pattern) VALUES ('notes', '/notes', '**/*')`
        );
        const insert = db.query(
          `INSERT INTO documents
             (collection, rel_path, source_hash, source_mime, source_ext,
              source_size, source_mtime, docid, uri, record_source_path, active)
           VALUES (?, ?, 'h', 'text/markdown', '.md', 1, '2024-01-01T00:00:00Z', '#a', 'gno://notes/x', ?, ?)`
        );
        insert.run("notes", "a/legacy.md", null, 1);
        insert.run("notes", "a/stale.md", null, 0);
        insert.run("notes", ".gno/records/h/one.md", "a/legacy.jsonl", 1);
        insert.run("notes", "legacy-root.md", null, 1);

        expect(runMigrations(db, migrations, "unicode61").ok).toBe(true);
        expect(getSchemaVersion(db)).toBe(27);
      } finally {
        db.close();
      }

      const upgraded = new SqliteAdapter();
      try {
        expect((await upgraded.open(upgradePath, "unicode61")).ok).toBe(true);
        const nested = await upgraded.listActiveDirectChildSourcePaths(
          "notes",
          "a"
        );
        expect(nested.ok).toBe(true);
        expect(nested.ok ? [...nested.value].sort() : []).toEqual([
          "a/legacy.jsonl",
          "a/legacy.md",
        ]);

        const root = await upgraded.listActiveDirectChildSourcePaths(
          "notes",
          ""
        );
        expect(root.ok ? root.value : []).toEqual(["legacy-root.md"]);
      } finally {
        await upgraded.close();
      }
    });

    test("results stay correct at scale", async () => {
      expect((await expectPaths("notes", "a")).length).toBe(400);
      expect((await expectPaths("notes", "a/deep")).length).toBe(400);
    });
  });
});
