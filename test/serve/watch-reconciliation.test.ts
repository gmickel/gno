/**
 * Focused unit tests for watcher event classification and reconciliation helpers.
 */

import { describe, expect, test } from "bun:test";
// node:fs/promises — test fixture setup
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
// node:os — tmpdir
import { tmpdir } from "node:os";
// node:path — Bun has no path utilities
import { join } from "node:path";

import type { Collection } from "../../src/config/types";
import type { CollectionSyncResult } from "../../src/ingestion";
import type { SqliteAdapter } from "../../src/store/sqlite/adapter";

import {
  WATCHER_MAX_DIRTY_HINTS,
  WATCHER_MAX_EXACT_PATHS,
  WATCHER_MAX_FLUSH_DELAY_MS,
  WATCHER_MAX_SUPPRESSION_ENTRIES,
  addToCappedSet,
  classifyDirtyHints,
  classifyWatcherFilename,
  hasFileLevelSyncError,
  mergeSyncPathBatch,
  pruneSuppressionMap,
  widenVanishedExactPaths,
} from "../../src/serve/watch-reconciliation";
import {
  computeFlushDelay,
  emptyPending,
  queueDirtyHint,
  queueExactPath,
  takePending,
} from "../../src/serve/watch-service-state";
import {
  buildWatcherSnapshot,
  createEmptyWatcherSnapshot,
} from "../../src/serve/watch-snapshot";
import { safeRm } from "../helpers/cleanup";

function createCollection(
  name: string,
  path: string,
  overrides: Partial<Collection> = {}
): Collection {
  return {
    name,
    path,
    pattern: "**/*.md",
    include: [],
    exclude: [],
    ...overrides,
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

function createSyncResult(
  overrides: Partial<CollectionSyncResult> = {}
): CollectionSyncResult {
  return {
    collection: "notes",
    filesProcessed: 0,
    filesAdded: 0,
    filesUpdated: 0,
    filesUnchanged: 0,
    filesErrored: 0,
    filesSkipped: 0,
    filesMarkedInactive: 0,
    durationMs: 1,
    errors: [],
    ...overrides,
  };
}

describe("classifyWatcherFilename", () => {
  const collection = createCollection("notes", "/tmp/notes");

  test("routes eligible files to exact", () => {
    expect(classifyWatcherFilename("note.md", collection)).toEqual({
      kind: "exact",
      relPath: "note.md",
    });
    expect(classifyWatcherFilename("sub/a.md", collection)).toEqual({
      kind: "exact",
      relPath: "sub/a.md",
    });
  });

  test("routes temp, ineligible, missing, and root shapes to dirty", () => {
    expect(classifyWatcherFilename("note.md.tmp", collection)).toEqual({
      kind: "dirty",
      hint: "note.md.tmp",
    });
    expect(classifyWatcherFilename(".gno-tmp.x", collection)).toEqual({
      kind: "dirty",
      hint: ".gno-tmp.x",
    });
    expect(classifyWatcherFilename("dir1", collection)).toEqual({
      kind: "dirty",
      hint: "dir1",
    });
    expect(classifyWatcherFilename(null, collection)).toEqual({
      kind: "dirty",
      hint: "",
    });
    expect(classifyWatcherFilename("", collection)).toEqual({
      kind: "dirty",
      hint: "",
    });
  });

  test("rejects absolute, escaping, NUL, and outside-root shaped hints", () => {
    expect(classifyWatcherFilename("/etc/passwd", collection).kind).toBe(
      "reject"
    );
    expect(classifyWatcherFilename("../escape.md", collection).kind).toBe(
      "reject"
    );
    expect(classifyWatcherFilename("a\0b.md", collection).kind).toBe("reject");
    expect(classifyWatcherFilename("C:/windows.md", collection).kind).toBe(
      "reject"
    );
  });

  test("ignores permanently excluded subtrees", () => {
    const excluded = createCollection("notes", "/tmp/notes", {
      exclude: [".obsidian", "private"],
    });
    expect(
      classifyWatcherFilename(".obsidian/workspace.json", excluded).kind
    ).toBe("ignore");
    expect(classifyWatcherFilename("private/note.md", excluded).kind).toBe(
      "ignore"
    );
  });
});

describe("capped sets and suppression pruning", () => {
  test("addToCappedSet reports overflow without silent drop of signal", () => {
    const set = new Set<string>(["a"]);
    expect(addToCappedSet(set, "a", 2)).toBe("exists");
    expect(addToCappedSet(set, "b", 2)).toBe("added");
    expect(addToCappedSet(set, "c", 2)).toBe("overflow");
    expect(set.has("c")).toBe(false);
  });

  test("queue helpers force root dirty on overflow", () => {
    const pending = emptyPending();
    for (let i = 0; i < WATCHER_MAX_DIRTY_HINTS; i += 1) {
      queueDirtyHint(pending, `tmp-${i}`, WATCHER_MAX_DIRTY_HINTS);
    }
    queueDirtyHint(pending, "overflow-hint", WATCHER_MAX_DIRTY_HINTS);
    expect(pending.overflow).toBe(true);
    expect(pending.dirty.has("")).toBe(true);
    expect(pending.dirty.size).toBe(1);

    const exact = emptyPending();
    for (let i = 0; i < WATCHER_MAX_EXACT_PATHS; i += 1) {
      queueExactPath(exact, `n${i}.md`, WATCHER_MAX_EXACT_PATHS);
    }
    queueExactPath(exact, "extra.md", WATCHER_MAX_EXACT_PATHS);
    expect(exact.overflow).toBe(true);
    expect(exact.dirty.has("")).toBe(true);

    // Overflow/force flags survive take → requeue restore.
    const taken = takePending(exact);
    expect(taken.overflow).toBe(true);
    expect(taken.forceFallback).toBe(true);
  });

  test("pruneSuppressionMap drops expired and enforces ceiling", () => {
    const map = new Map<string, number>([
      ["/a", 10],
      ["/b", 20],
      ["/c", 30],
      ["/d", 40],
    ]);
    pruneSuppressionMap(map, 25, 2);
    expect(map.size).toBe(2);
    expect(map.has("/c")).toBe(true);
    expect(map.has("/d")).toBe(true);
    expect(WATCHER_MAX_SUPPRESSION_ENTRIES).toBeGreaterThan(0);
  });

  test("hard flush deadline bounds sustained debounce re-arm", () => {
    const first = computeFlushDelay({
      nowMs: 1_000,
      existingDeadlineAt: undefined,
      debounceMs: 300,
      maxFlushDelayMs: WATCHER_MAX_FLUSH_DELAY_MS,
    });
    expect(first.delayMs).toBe(300);
    expect(first.deadlineAt).toBe(1_000 + WATCHER_MAX_FLUSH_DELAY_MS);

    const nearEnd = computeFlushDelay({
      nowMs: first.deadlineAt - 50,
      existingDeadlineAt: first.deadlineAt,
      debounceMs: 300,
      maxFlushDelayMs: WATCHER_MAX_FLUSH_DELAY_MS,
    });
    expect(nearEnd.delayMs).toBe(50);

    const past = computeFlushDelay({
      nowMs: first.deadlineAt + 10,
      existingDeadlineAt: first.deadlineAt,
      debounceMs: 300,
      maxFlushDelayMs: WATCHER_MAX_FLUSH_DELAY_MS,
    });
    expect(past.delayMs).toBe(0);
  });
});

describe("hasFileLevelSyncError and mergeSyncPathBatch", () => {
  test("detects errored files and top-level errors", () => {
    expect(hasFileLevelSyncError(createSyncResult())).toBe(false);
    expect(hasFileLevelSyncError(createSyncResult({ filesErrored: 1 }))).toBe(
      true
    );
    expect(
      hasFileLevelSyncError(
        createSyncResult({
          files: [{ relPath: "a.md", status: "error", errorCode: "X" }],
        })
      )
    ).toBe(true);
    expect(
      hasFileLevelSyncError(
        createSyncResult({
          errors: [{ relPath: "a.md", code: "X", message: "nope" }],
        })
      )
    ).toBe(true);
  });

  test("dedupes exact, candidates, and removals", () => {
    expect(
      mergeSyncPathBatch(["b.md", "a.md"], ["a.md", "c.md"], ["c.md", "d.md"])
    ).toEqual(["a.md", "b.md", "c.md", "d.md"]);
  });
});

describe("classifyDirtyHints and widenVanishedExactPaths", () => {
  test("snapshot path selects only changed candidate among siblings", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-recon-"));
    try {
      await writeFile(join(root, "keep.md"), "one");
      await writeFile(join(root, "change.md"), "old");
      const built = await buildWatcherSnapshot(root);
      expect(built.status).toBe("ok");
      if (built.status !== "ok") {
        throw new Error("snapshot required");
      }

      await writeFile(join(root, "change.md"), "new-content-longer");
      // Ambiguous temp hint in the same directory.
      const classified = await classifyDirtyHints({
        collection: createCollection("notes", root),
        store: createStubStore(),
        rootAbs: root,
        previous: built.snapshot,
        dirtyHints: ["change.md.tmp"],
      });
      expect(classified.status).toBe("ok");
      if (classified.status !== "ok") {
        throw new Error("expected ok");
      }
      expect(classified.candidates).toContain("change.md");
      expect(classified.candidates).not.toContain("keep.md");
      expect(classified.nextSnapshot).not.toBeNull();
    } finally {
      await safeRm(root);
    }
  });

  test("recursive deletion expands removals from prior snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-del-"));
    try {
      await mkdir(join(root, "dir1", "sub"), { recursive: true });
      await writeFile(join(root, "dir1", "a.md"), "a");
      await writeFile(join(root, "dir1", "sub", "b.md"), "b");
      await writeFile(join(root, "sibling.md"), "s");
      const built = await buildWatcherSnapshot(root);
      expect(built.status).toBe("ok");
      if (built.status !== "ok") {
        throw new Error("snapshot required");
      }

      await safeRm(join(root, "dir1"));
      const classified = await classifyDirtyHints({
        collection: createCollection("notes", root),
        store: createStubStore(),
        rootAbs: root,
        previous: built.snapshot,
        dirtyHints: ["dir1"],
      });
      expect(classified.status).toBe("ok");
      if (classified.status !== "ok") {
        throw new Error("expected ok");
      }
      expect(classified.removals.sort()).toEqual(
        ["dir1/a.md", "dir1/sub/b.md"].sort()
      );
      expect(classified.candidates).not.toContain("sibling.md");
    } finally {
      await safeRm(root);
    }
  });

  test("new directory children become candidates", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-newdir-"));
    try {
      await writeFile(join(root, "root.md"), "r");
      const built = await buildWatcherSnapshot(root);
      expect(built.status).toBe("ok");
      if (built.status !== "ok") {
        throw new Error("snapshot required");
      }

      await mkdir(join(root, "fresh"), { recursive: true });
      await writeFile(join(root, "fresh", "n.md"), "n");
      const classified = await classifyDirtyHints({
        collection: createCollection("notes", root),
        store: createStubStore(),
        rootAbs: root,
        previous: built.snapshot,
        dirtyHints: ["fresh"],
      });
      expect(classified.status).toBe("ok");
      if (classified.status !== "ok") {
        throw new Error("expected ok");
      }
      expect(classified.candidates).toContain("fresh/n.md");
    } finally {
      await safeRm(root);
    }
  });

  test("store failure does not infer inactivation", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-storefail-"));
    try {
      await mkdir(join(root, "nested"), { recursive: true });
      await writeFile(join(root, "nested", "a.md"), "a");
      const classified = await classifyDirtyHints({
        collection: createCollection("notes", root),
        store: createStubStore({
          // Non-root inventory uses descendants alone (not direct-child).
          listActiveDescendantSourcePaths: async () => ({
            ok: false,
            error: { code: "QUERY_FAILED", message: "boom" },
          }),
        }),
        rootAbs: root,
        previous: null,
        // Parent expands to "nested" only (not root) so non-root store path runs.
        dirtyHints: ["nested/a.md.tmp"],
      });
      expect(classified.status).toBe("error");
      if (classified.status === "error") {
        expect(classified.stage).toBe("store");
      }
    } finally {
      await safeRm(root);
    }
  });

  test("partial scan failure keeps prior snapshot uncommitted (null next)", async () => {
    const classified = await classifyDirtyHints({
      collection: createCollection("notes", "/no/such/root-xyz"),
      store: createStubStore(),
      rootAbs: "/no/such/root-xyz",
      previous: createEmptyWatcherSnapshot(),
      dirtyHints: ["gone.md.tmp"],
    });
    // Missing root must error/retry — never prove store deletions.
    expect(classified.status).toBe("error");
    if (classified.status === "error") {
      expect(classified.stage).toBe("scan");
    }
  });

  test("widenVanishedExactPaths dirties missing exact paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-widen-"));
    try {
      await writeFile(join(root, "live.md"), "x");
      const widened = await widenVanishedExactPaths(root, [
        "live.md",
        "gone.md",
      ]);
      expect(widened.keepExact).toEqual(["live.md", "gone.md"]);
      expect(widened.extraDirty).toContain("gone.md");
      expect(widened.extraDirty).toContain("");
    } finally {
      await safeRm(root);
    }
  });

  test("widenVanishedExactPaths moves present directory out of keepExact into dirty only", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-widen-dir-"));
    try {
      await mkdir(join(root, "folder.md"), { recursive: true });
      await writeFile(join(root, "folder.md", "child.md"), "c");
      const widened = await widenVanishedExactPaths(root, ["folder.md"]);
      expect(widened.keepExact).toEqual([]);
      expect(widened.extraDirty).toEqual(["folder.md"]);
      expect(widened.directoryDirty).toEqual(["folder.md"]);
    } finally {
      await safeRm(root);
    }
  });

  test("widenVanishedExactPaths moves FIFO/other out of keepExact into dirty only", async () => {
    const root = await mkdtemp(join(tmpdir(), "gno-watch-widen-fifo-"));
    try {
      const fifoPath = join(root, "special.md");
      let mkfifoOk = false;
      try {
        const proc = Bun.spawn(["mkfifo", fifoPath], {
          stdout: "ignore",
          stderr: "pipe",
        });
        mkfifoOk = (await proc.exited) === 0;
      } catch {
        mkfifoOk = false;
      }
      if (!mkfifoOk) {
        // Platform without mkfifo — skip only this special-file unit.
        return;
      }
      const widened = await widenVanishedExactPaths(root, [
        "special.md",
        "missing.md",
      ]);
      expect(widened.keepExact).toEqual(["missing.md"]);
      expect(widened.extraDirty).toContain("special.md");
      expect(widened.directoryDirty).toContain("special.md");
      expect(widened.keepExact).not.toContain("special.md");
    } finally {
      await safeRm(root);
    }
  });
});
