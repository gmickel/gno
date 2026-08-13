/**
 * Fallback root/error/forceFallback bounds for host review findings.
 */

import { describe, expect, test } from "bun:test";
// node:fs/promises — test fixture setup
import { mkdtemp, writeFile } from "node:fs/promises";
// node:os — tmpdir
import { tmpdir } from "node:os";
// node:path — Bun has no path utilities
import { join } from "node:path";

import type { Collection } from "../../src/config/types";
import type { SqliteAdapter } from "../../src/store/sqlite/adapter";

import { classifyDirtyHints } from "../../src/serve/watch-reconciliation";
import { buildWatcherSnapshot } from "../../src/serve/watch-snapshot";
import { safeRm } from "../helpers/cleanup";

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
    ...overrides,
  } as unknown as SqliteAdapter;
}

describe("fallback root and forceFallback", () => {
  test("missing collection root errors instead of proving deletion", async () => {
    const classified = await classifyDirtyHints({
      collection: createCollection("notes", "/no/such/root-missing-xyz"),
      store: createStubStore({
        listActiveDirectChildSourcePaths: async () => ({
          ok: true,
          value: ["nested/a.md", "top.md"],
        }),
        listDocumentsPaginated: async () => ({
          ok: true,
          value: {
            documents: [
              { relPath: "nested/a.md", recordSourcePath: null },
              { relPath: "top.md", recordSourcePath: null },
            ],
            total: 2,
          },
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
          listDocumentsPaginated: async () => ({
            ok: true,
            value: {
              documents: [
                { relPath: "keep.md", recordSourcePath: null },
                { relPath: "gone/nested.md", recordSourcePath: null },
              ],
              total: 2,
            },
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
