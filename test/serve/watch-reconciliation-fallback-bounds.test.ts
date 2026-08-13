/**
 * Fallback root/error/forceFallback bounds for host review findings.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
// node:fs/promises — test fixture setup
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
// node:os — tmpdir
import { tmpdir } from "node:os";
// node:path — Bun has no path utilities
import { join } from "node:path";

import type { Collection } from "../../src/config/types";
import type { SqliteAdapter } from "../../src/store/sqlite/adapter";
import type { DocumentInput } from "../../src/store/types";

import { classifyDirtyHints } from "../../src/serve/watch-reconciliation";
import { collapseOverlappingDirtyDirs } from "../../src/serve/watch-reconciliation-fallback";
import { buildWatcherSnapshot } from "../../src/serve/watch-snapshot";
import { SqliteAdapter as RealSqliteAdapter } from "../../src/store";
import { safeRm } from "../helpers/cleanup";

if (process.platform === "win32") {
  setDefaultTimeout(30_000);
}

function createCollection(name: string, path: string): Collection {
  return {
    name,
    path,
    pattern: "**/*.md",
    include: [],
    exclude: [],
  };
}

function createStubStore(
  overrides: Partial<SqliteAdapter> = {}
): SqliteAdapter {
  return {
    listActiveDirectChildSourcePaths: async () => ({ ok: true, value: [] }),
    listActiveDescendantSourcePaths: async () => ({ ok: true, value: [] }),
    listActiveSourcePaths: async () => ({ ok: true, value: [] }),
    ...overrides,
  } as unknown as SqliteAdapter;
}

describe("collapse overlapping dirty dirs", () => {
  test("ancestor absorbs descendants; root absorbs all", () => {
    expect(collapseOverlappingDirtyDirs(["sub", "sub/subchild"])).toEqual([
      "sub",
    ]);
    expect(collapseOverlappingDirtyDirs(["", "a", "a/b"])).toEqual([""]);
    expect(collapseOverlappingDirtyDirs(["a", "b"])).toEqual(["a", "b"]);
  });
});

describe("fallback root and forceFallback", () => {
  test("missing collection root errors instead of proving deletion", async () => {
    const classified = await classifyDirtyHints({
      collection: createCollection("notes", "/no/such/root-missing-xyz"),
      store: createStubStore({
        listActiveDirectChildSourcePaths: async () => ({
          ok: true,
          value: ["nested/a.md", "top.md"],
        }),
        listActiveSourcePaths: async () => ({
          ok: true,
          value: ["nested/a.md", "top.md"],
        }),
      } as never),
      rootAbs: "/no/such/root-missing-xyz",
      previous: null,
      dirtyHints: [""],
    });
    expect(classified.status).toBe("error");
    if (classified.status === "error") {
      expect(classified.stage).toBe("scan");
      expect(String(classified.cause)).toMatch(/root/i);
    }
  });

  test("root dirty compares nested active store sources via bounded inventory", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-root-nested-"));
    try {
      await writeFile(join(root, "keep.md"), "k");
      const classified = await classifyDirtyHints({
        collection: createCollection("notes", root),
        store: createStubStore({
          listActiveDirectChildSourcePaths: async (_c: string, dir: string) => {
            if (dir === "") {
              return { ok: true, value: ["keep.md"] };
            }
            return { ok: true, value: [] };
          },
          listActiveSourcePaths: async () => ({
            ok: true,
            value: ["gone/nested.md", "keep.md"],
          }),
        } as never),
        rootAbs: root,
        previous: null,
        dirtyHints: [""],
      });
      expect(classified.status).toBe("ok");
      if (classified.status !== "ok") {
        throw new Error("expected ok");
      }
      expect(classified.usedFallback).toBe(true);
      expect(classified.candidates).toContain("keep.md");
      expect(classified.removals).toContain("gone/nested.md");
    } finally {
      await safeRm(root);
    }
  });

  test("forceFallback lists present eligible finals even when baseline absorbed them", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-force-fb-"));
    try {
      await writeFile(join(root, "doc.md"), "final-content");
      const built = await buildWatcherSnapshot(root);
      expect(built.status).toBe("ok");
      if (built.status !== "ok") {
        throw new Error("snapshot required");
      }
      const classified = await classifyDirtyHints({
        collection: createCollection("notes", root),
        store: createStubStore(),
        rootAbs: root,
        previous: built.snapshot,
        dirtyHints: ["doc.md.tmp"],
        forceFallback: true,
      });
      expect(classified.status).toBe("ok");
      if (classified.status !== "ok") {
        throw new Error("expected ok");
      }
      expect(classified.usedFallback).toBe(true);
      expect(classified.candidates).toContain("doc.md");
    } finally {
      await safeRm(root);
    }
  });
});

describe("root inventory scale without false overflow", () => {
  let adapter: RealSqliteAdapter;
  let testDir = "";

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "gno-watch-root-5k-"));
    adapter = new RealSqliteAdapter();
    await adapter.open(join(testDir, "test.sqlite"), "unicode61");
    await adapter.syncCollections([
      {
        name: "notes",
        path: testDir,
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

  function doc(
    overrides: Partial<DocumentInput> & { relPath: string }
  ): DocumentInput {
    return {
      collection: "notes",
      sourceHash: `hash_${overrides.relPath}`,
      sourceMime: "text/markdown",
      sourceExt: ".md",
      sourceSize: 10,
      sourceMtime: "2024-01-01T00:00:00Z",
      ...overrides,
    };
  }

  test("5000 root files/sources + record-container dups do not false-overflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-disk-5k-"));
    try {
      const expected: string[] = [];
      for (let i = 0; i < 5000; i += 1) {
        const rel = `n${String(i).padStart(4, "0")}.md`;
        expected.push(rel);
        await writeFile(join(root, rel), `c${i}`);
        await adapter.upsertDocument(doc({ relPath: rel }));
      }
      // Many logical record docs → one physical source (must not inflate budget).
      for (let i = 0; i < 50; i += 1) {
        await adapter.upsertDocument(
          doc({
            relPath: `.gno/records/h/rec-${i}.md`,
            recordSourcePath: "export.jsonl",
            recordKey: `k${i}`,
            sourceHash: `rec_${i}`,
          })
        );
      }
      await writeFile(join(root, "export.jsonl"), "{}\n");

      // Prove direct-child is never required for root inventory.
      let directCalls = 0;
      const originalDirect =
        adapter.listActiveDirectChildSourcePaths.bind(adapter);
      adapter.listActiveDirectChildSourcePaths = (async (...args) => {
        directCalls += 1;
        return originalDirect(...args);
      }) as typeof adapter.listActiveDirectChildSourcePaths;

      const classified = await classifyDirtyHints({
        collection: {
          name: "notes",
          path: root,
          pattern: "**/*",
          include: [],
          exclude: [],
        },
        store: adapter,
        rootAbs: root,
        previous: null,
        dirtyHints: [""],
        sourcePathMax: 8_192,
      });

      expect(classified.status).toBe("ok");
      if (classified.status !== "ok") {
        throw new Error(`expected ok, got ${classified.status}`);
      }
      expect(classified.usedFallback).toBe(true);
      expect(classified.candidates.length).toBeGreaterThanOrEqual(5000);
      expect(classified.candidates).toContain("n0000.md");
      expect(classified.candidates).toContain("n4999.md");
      expect(classified.candidates).toContain("export.jsonl");
      // Root must use listActiveSourcePaths only — no direct-child call.
      expect(directCalls).toBe(0);
    } finally {
      await safeRm(root);
    }
  }, 60_000);

  test("5000 files under sub/ + overlapping sub/subchild hints no false overflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-sub-5k-"));
    try {
      await mkdir(join(root, "group", "sub", "subchild"), { recursive: true });
      const expected: string[] = [];
      for (let i = 0; i < 5000; i += 1) {
        const rel = `group/sub/n${String(i).padStart(4, "0")}.md`;
        expected.push(rel);
        await writeFile(join(root, rel), `c${i}`);
        await adapter.upsertDocument(doc({ relPath: rel }));
      }
      await writeFile(join(root, "group/sub/subchild/extra.md"), "x");
      await adapter.upsertDocument(
        doc({ relPath: "group/sub/subchild/extra.md" })
      );

      let directCalls = 0;
      const originalDirect =
        adapter.listActiveDirectChildSourcePaths.bind(adapter);
      adapter.listActiveDirectChildSourcePaths = (async (...args) => {
        directCalls += 1;
        return originalDirect(...args);
      }) as typeof adapter.listActiveDirectChildSourcePaths;

      let descendantCalls = 0;
      const originalDesc =
        adapter.listActiveDescendantSourcePaths.bind(adapter);
      adapter.listActiveDescendantSourcePaths = (async (...args) => {
        descendantCalls += 1;
        return originalDesc(...args);
      }) as typeof adapter.listActiveDescendantSourcePaths;

      const classified = await classifyDirtyHints({
        collection: {
          name: "notes",
          path: root,
          pattern: "**/*",
          include: [],
          exclude: [],
        },
        store: adapter,
        rootAbs: root,
        previous: null,
        dirtyHints: ["group/sub", "group/sub/subchild"],
        sourcePathMax: 8_192,
      });

      expect(classified.status).toBe("ok");
      if (classified.status !== "ok") {
        throw new Error(`expected ok, got ${classified.status}`);
      }
      expect(classified.usedFallback).toBe(true);
      expect(classified.candidates.length).toBeGreaterThanOrEqual(5000);
      expect(classified.candidates).toContain(expected[0] as string);
      expect(classified.candidates).toContain(expected[4999] as string);
      expect(classified.candidates).toContain("group/sub/subchild/extra.md");
      // Non-root inventory uses descendants alone; never direct-child.
      expect(directCalls).toBe(0);
      expect(descendantCalls).toBeGreaterThanOrEqual(1);
    } finally {
      await safeRm(root);
    }
  }, 60_000);
});
