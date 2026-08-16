/**
 * Watcher snapshot descent refuses dataless directories and preserves prior
 * subtree entries instead of proving removals.
 */

import { describe, expect, test } from "bun:test";

import type {
  DirectoryAvailabilityPort,
  DirectoryAvailabilityResult,
} from "../../src/ingestion/source-availability";
import type { SqliteAdapter } from "../../src/store/sqlite/adapter";

import { classifyDirtyHints } from "../../src/serve/watch-reconciliation";
import { beginSnapshotInit } from "../../src/serve/watch-service-snapshot";
import {
  buildWatcherSnapshot,
  createEmptyWatcherSnapshot,
  diffWatcherSnapshot,
  type SnapshotEntryFingerprint,
  type WatcherSnapshot,
  type WatcherSnapshotFs,
} from "../../src/serve/watch-snapshot";

function fp(
  kind: SnapshotEntryFingerprint["kind"],
  inode: number
): SnapshotEntryFingerprint {
  return {
    kind,
    device: 1n,
    inode: BigInt(inode),
    size: kind === "directory" ? 0 : 10,
    mtimeNs: 1n,
    ctimeNs: 1n,
  };
}

function memoryFs(tree: Record<string, string[]>): WatcherSnapshotFs {
  const handles = new Map<object, string>();
  let seq = 0;
  return {
    supportsAnchoredHandles: true,
    readDirectChildrenSync: (_rootAbs, dirRel, maxEntries) => {
      const names = tree[dirRel] ?? [];
      if (names.length > maxEntries) {
        return { status: "overflow" };
      }
      const entries = new Map<string, SnapshotEntryFingerprint>();
      for (const name of names) {
        const childRel = dirRel === "" ? name : `${dirRel}/${name}`;
        entries.set(
          name,
          fp(
            Object.hasOwn(tree, childRel) ? "directory" : "file",
            childRel.length + 10
          )
        );
      }
      return { status: "present", entries };
    },
    lstatChildByRelSync: (_rootAbs, parentRel, name) => {
      const childRel = parentRel === "" ? name : `${parentRel}/${name}`;
      const directory = Object.hasOwn(tree, childRel);
      return {
        isFile: () => !directory,
        isDirectory: () => directory,
        isSymbolicLink: () => false,
        dev: 1,
        ino: childRel.length + 10,
        size: directory ? 0 : 10,
        mtimeNs: 1n,
        ctimeNs: 1n,
      };
    },
    openDir: async (absPath: string) => {
      const handle = { __watcherDirHandle: Symbol(String(++seq)) } as never;
      const key =
        absPath === "/" || absPath === "" ? "" : absPath.replace(/^\//, "");
      handles.set(handle, key);
      return handle;
    },
    openChildDir: async (handle, name) => {
      const parent = handles.get(handle) ?? "";
      const childRel = parent === "" ? name : `${parent}/${name}`;
      const child = { __watcherDirHandle: Symbol(String(++seq)) } as never;
      handles.set(child, childRel);
      return child;
    },
    readDir: async (handle) => {
      const rel = handles.get(handle) ?? "";
      const names = tree[rel] ?? [];
      return { status: "ok", names: [...names] };
    },
    lstatChild: async (handle, name) => {
      const parent = handles.get(handle) ?? "";
      const childRel = parent === "" ? name : `${parent}/${name}`;
      const directory = Object.hasOwn(tree, childRel);
      return {
        isFile: () => !directory,
        isDirectory: () => directory,
        isSymbolicLink: () => false,
        dev: 1,
        ino: childRel.length + 10,
        size: directory ? 0 : 10,
        mtimeNs: 1n,
        ctimeNs: 1n,
      };
    },
    closeDir: async () => undefined,
  };
}

function directoryClassifier(
  decide: (absPath: string) => DirectoryAvailabilityResult
): DirectoryAvailabilityPort {
  return {
    mode: "local",
    classify: async (absPath) => decide(absPath),
    readDirectory: (absPath, read) => {
      const classified = decide(absPath);
      return classified.kind === "available"
        ? { kind: "available", value: read() }
        : classified;
    },
  };
}

function blockAtDirectoryRead(
  blockedSuffix: string
): DirectoryAvailabilityPort {
  return {
    mode: "local",
    classify: async () => ({ kind: "available" }),
    readDirectory: (absPath, read) => {
      if (absPath.endsWith(blockedSuffix)) {
        return {
          kind: "dataless",
          code: "DATALESS_DIRECTORY",
          message: "became dataless before enumeration",
        };
      }
      return { kind: "available", value: read() };
    },
  };
}

describe("watcher snapshot source-availability descent", () => {
  test("build refuses descent into dataless child directory", async () => {
    const fs = memoryFs({
      "": ["cloud", "local.md"],
      cloud: ["hidden.md"],
    });
    const classifier = directoryClassifier((absPath) => {
      if (absPath.endsWith("/cloud") || absPath === "cloud") {
        return {
          kind: "dataless",
          code: "DATALESS_DIRECTORY",
          message: "dataless",
        };
      }
      return { kind: "available" };
    });

    const built = await buildWatcherSnapshot("/", {
      fs,
      directoryAvailability: classifier,
    });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") return;

    expect(built.snapshot.directories.has("")).toBe(true);
    expect(built.snapshot.directories.has("cloud")).toBe(false);
    const rootEntries = built.snapshot.directories.get("");
    expect(rootEntries?.has("cloud")).toBe(true);
    expect(rootEntries?.has("local.md")).toBe(true);
    expect(built.snapshot.unprovenSubtrees).toEqual(new Set(["cloud"]));
  });

  test("build refuses a child that becomes dataless before enumeration", async () => {
    const built = await buildWatcherSnapshot("/", {
      fs: memoryFs({
        "": ["cloud", "local.md"],
        cloud: ["hidden.md"],
      }),
      directoryAvailability: blockAtDirectoryRead("/cloud"),
    });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") return;
    expect(built.snapshot.directories.has("cloud")).toBe(false);
    expect(built.snapshot.directories.get("")?.has("cloud")).toBe(true);
    expect(built.snapshot.unprovenSubtrees).toEqual(new Set(["cloud"]));
  });

  test("proven deletion of an unproven snapshot subtree forces full reconciliation", async () => {
    const tree: Record<string, string[]> = {
      "": ["cloud", "local.md"],
      cloud: ["previously-indexed.md"],
    };
    const classifier = directoryClassifier((absPath) => {
      if (absPath.endsWith("/cloud") || absPath === "cloud") {
        return {
          kind: "dataless",
          code: "DATALESS_DIRECTORY",
          message: "dataless",
        };
      }
      return { kind: "available" };
    });
    const fs = memoryFs(tree);
    const built = await buildWatcherSnapshot("/", {
      fs,
      directoryAvailability: classifier,
    });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") return;

    tree[""] = ["local.md"];
    delete tree.cloud;
    const classified = await classifyDirtyHints({
      collection: {
        name: "notes",
        path: "/",
        pattern: "**/*.md",
        include: [],
        exclude: [],
        sourceAvailability: "local",
      },
      store: {} as SqliteAdapter,
      rootAbs: "/",
      previous: built.snapshot,
      dirtyHints: [""],
      snapshotOptions: { fs, directoryAvailability: classifier },
    });

    expect(classified).toEqual({
      status: "full_reconcile",
      reason: "snapshot_unproven_subtree",
    });
  });

  test("replacement of an unproven snapshot subtree forces full reconciliation", async () => {
    const previous: WatcherSnapshot = {
      directories: new Map([["", new Map([["cloud", fp("directory", 1)]])]]),
      entryCount: 1,
      unprovenSubtrees: new Set(["cloud"]),
    };
    const classified = await classifyDirtyHints({
      collection: {
        name: "notes",
        path: "/",
        pattern: "**/*.md",
        include: [],
        exclude: [],
        sourceAvailability: "local",
      },
      store: {} as SqliteAdapter,
      rootAbs: "/",
      previous,
      dirtyHints: [""],
      snapshotOptions: {
        fs: memoryFs({ "": ["cloud"] }),
        directoryAvailability: directoryClassifier(() => ({
          kind: "available",
        })),
      },
    });

    expect(classified).toEqual({
      status: "full_reconcile",
      reason: "snapshot_unproven_subtree",
    });
  });

  test("diff preserves prior subtree when dirty directory becomes dataless", async () => {
    const previous: WatcherSnapshot = {
      directories: new Map([
        [
          "",
          new Map([
            ["cloud", fp("directory", 1)],
            ["local.md", fp("file", 2)],
          ]),
        ],
        ["cloud", new Map([["kept.md", fp("file", 3)]])],
      ]),
      entryCount: 3,
    };

    const fs = memoryFs({
      "": ["cloud", "local.md"],
      cloud: ["kept.md"],
    });
    const classifier = directoryClassifier((absPath) => {
      if (absPath.endsWith("/cloud") || absPath === "cloud") {
        return {
          kind: "dataless",
          code: "DATALESS_DIRECTORY",
          message: "dataless",
        };
      }
      return { kind: "available" };
    });

    const diff = await diffWatcherSnapshot("/", previous, ["cloud"], {
      fs,
      directoryAvailability: classifier,
    });
    expect(diff.status).toBe("ok");
    if (diff.status !== "ok") return;
    expect(diff.removals).toEqual([]);
    expect(diff.nextSnapshot.directories.get("cloud")?.has("kept.md")).toBe(
      true
    );
  });

  test("diff preserves prior subtree when availability changes before enumeration", async () => {
    const previous: WatcherSnapshot = {
      directories: new Map([
        ["", new Map([["cloud", fp("directory", 1)]])],
        ["cloud", new Map([["kept.md", fp("file", 2)]])],
      ]),
      entryCount: 2,
    };
    const diff = await diffWatcherSnapshot("/", previous, ["cloud"], {
      fs: memoryFs({ "": ["cloud"], cloud: [] }),
      directoryAvailability: blockAtDirectoryRead("/cloud"),
    });
    expect(diff.status).toBe("ok");
    if (diff.status !== "ok") return;
    expect(diff.removals).toEqual([]);
    expect(diff.nextSnapshot.directories.get("cloud")?.has("kept.md")).toBe(
      true
    );
  });

  test("new-subtree scan refuses a directory that changes before enumeration", async () => {
    const diff = await diffWatcherSnapshot(
      "/",
      {
        directories: new Map([["", new Map()]]),
        entryCount: 0,
      },
      [""],
      {
        fs: memoryFs({
          "": ["cloud"],
          cloud: ["hidden.md"],
        }),
        directoryAvailability: blockAtDirectoryRead("/cloud"),
      }
    );
    expect(diff.status).toBe("ok");
    if (diff.status !== "ok") return;
    expect(diff.candidates).toEqual([]);
    expect(diff.nextSnapshot.directories.has("cloud")).toBe(false);
    expect(diff.nextSnapshot.directories.get("")?.has("cloud")).toBe(true);
  });

  test("fallback preserves descendants when availability changes before enumeration", async () => {
    const fs = memoryFs({
      "": ["cloud", "local.md"],
      cloud: ["kept.md"],
    });
    const classifier = blockAtDirectoryRead("/cloud");
    const store = {
      listActiveSourcePaths: async () => ({
        ok: true as const,
        value: ["cloud/kept.md", "local.md"],
      }),
      listActiveDirectChildSourcePaths: async () => ({
        ok: true as const,
        value: [],
      }),
      listActiveDescendantSourcePaths: async () => ({
        ok: true as const,
        value: [],
      }),
    } as unknown as SqliteAdapter;

    const classified = await classifyDirtyHints({
      collection: {
        name: "notes",
        path: "/",
        pattern: "**/*.md",
        include: [],
        exclude: [],
        sourceAvailability: "local",
      },
      store,
      rootAbs: "/",
      previous: null,
      dirtyHints: [""],
      snapshotOptions: { fs, directoryAvailability: classifier },
    });

    expect(classified.status).toBe("ok");
    if (classified.status !== "ok") return;
    expect(classified.candidates).toEqual(["local.md"]);
    expect(classified.removals).toEqual([]);
  });

  test("snapshot init honors a local run-level override", async () => {
    const snapshots = new Map<string, WatcherSnapshot>();
    const inits = new Map<string, Promise<void>>();
    let observedMode = "unset";
    beginSnapshotInit(
      {
        disposed: () => false,
        getGeneration: () => 1,
        getRoot: () => "/collection",
        setSnapshot: (name, snapshot) => snapshots.set(name, snapshot),
        clearSnapshot: (name) => snapshots.delete(name),
        setReady: () => undefined,
        getInit: (name) => inits.get(name),
        setInit: (name, init) => {
          if (init) inits.set(name, init);
          else inits.delete(name);
        },
        onReadyWithPending: () => undefined,
        getSyncOptions: () => ({ sourceAvailability: "local" }),
        buildSnapshot: async (_root, options) => {
          observedMode = options?.directoryAvailability?.mode ?? "missing";
          return {
            status: "ok",
            snapshot: createEmptyWatcherSnapshot(),
            durationMs: 0,
          };
        },
      },
      {
        name: "notes",
        path: "/collection",
        pattern: "**/*.md",
        include: [],
        exclude: [],
        sourceAvailability: "any",
      }
    );
    const init = inits.get("notes");
    expect(init).toBeDefined();
    await init;
    expect(observedMode).toBe("local");
    expect(snapshots.has("notes")).toBe(true);
  });
});
