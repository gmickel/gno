/**
 * Snapshot other-kind contract: FIFO/socket/device entries are never candidates.
 *
 * Injected tree covers kind transitions without depending on mkfifo.
 * Production suite covers real FIFO hang safety separately.
 */

import { describe, expect, test } from "bun:test";

import type {
  SnapshotEntryFingerprint,
  WatcherSnapshotFs,
  WatcherSnapshotStat,
} from "../../src/serve/watch-snapshot";

import {
  buildWatcherSnapshot,
  createPathBackedWatcherFs,
  diffWatcherSnapshot,
} from "../../src/serve/watch-snapshot";
import { snapshotFingerprint } from "./helpers/watch-snapshot-fixtures";

type Node =
  | { kind: "dir"; children: Map<string, Node>; dev: bigint; ino: bigint }
  | {
      kind: "file" | "symlink" | "other";
      dev: bigint;
      ino: bigint;
      size: number;
      mtimeNs: bigint;
      ctimeNs: bigint;
    };

function fileNode(
  ino: bigint,
  opts?: { kind?: "file" | "symlink" | "other"; size?: number }
): Extract<Node, { kind: "file" | "symlink" | "other" }> {
  return {
    kind: opts?.kind ?? "file",
    dev: 1n,
    ino,
    size: opts?.size ?? 1,
    mtimeNs: 1_000n,
    ctimeNs: 1_000n,
  };
}

function dirNode(
  ino: bigint,
  children: Record<string, Node> = {}
): Extract<Node, { kind: "dir" }> {
  return {
    kind: "dir",
    dev: 1n,
    ino,
    children: new Map(Object.entries(children)),
  };
}

function nodeToStat(node: Node): WatcherSnapshotStat {
  if (node.kind === "dir") {
    return {
      isFile: () => false,
      isDirectory: () => true,
      isSymbolicLink: () => false,
      dev: node.dev,
      ino: node.ino,
      size: 0,
      mtimeNs: 1_000n,
      ctimeNs: 1_000n,
    };
  }
  return {
    isFile: () => node.kind === "file",
    isDirectory: () => false,
    isSymbolicLink: () => node.kind === "symlink",
    dev: node.dev,
    ino: node.ino,
    size: node.size,
    mtimeNs: node.mtimeNs,
    ctimeNs: node.ctimeNs,
  };
}

function resolveNode(root: Node, absPath: string): Node | null {
  // Paths are virtual: root is "/", children joined with "/".
  if (absPath === "/" || absPath === "") {
    return root;
  }
  const rel = absPath.startsWith("/") ? absPath.slice(1) : absPath;
  if (rel === "") {
    return root;
  }
  let current: Node = root;
  for (const segment of rel.split("/")) {
    if (current.kind !== "dir") {
      return null;
    }
    const next = current.children.get(segment);
    if (!next) {
      return null;
    }
    current = next;
  }
  return current;
}

function createInjectedFs(getRoot: () => Extract<Node, { kind: "dir" }>): {
  fs: WatcherSnapshotFs;
} {
  const fs = createPathBackedWatcherFs({
    readdir: async (absPath: string) => {
      const node = resolveNode(getRoot(), absPath);
      if (!node || node.kind !== "dir") {
        throw Object.assign(new Error("ENOTDIR"), { code: "ENOTDIR" });
      }
      return [...node.children.keys()];
    },
    lstat: async (absPath: string) => {
      const node = resolveNode(getRoot(), absPath);
      if (!node) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return nodeToStat(node);
    },
  });
  return { fs };
}

function expectOtherFingerprint(
  fp: SnapshotEntryFingerprint | undefined
): void {
  expect(fp).toBeDefined();
  expect(fp?.kind).toBe("other");
}

describe("watcher snapshot other-kind contract (injected)", () => {
  test("newly added other (FIFO) is fingerprint-only — not a candidate", async () => {
    let root = dirNode(1n, {
      "keep.md": fileNode(2n),
    });
    const { fs } = createInjectedFs(() => root);

    const built = await buildWatcherSnapshot("/", { fs });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    root = dirNode(1n, {
      "keep.md": fileNode(2n),
      "pipe.fifo": fileNode(3n, { kind: "other" }),
    });

    const diff = await diffWatcherSnapshot("/", built.snapshot, [""], { fs });
    expect(diff.status).toBe("ok");
    if (diff.status !== "ok") {
      return;
    }
    expect(diff.candidates).toEqual([]);
    expect(diff.removals).toEqual([]);
    expectOtherFingerprint(
      diff.nextSnapshot.directories.get("")?.get("pipe.fifo")
    );
  });

  test("file → other: old path in removals, no candidate, other fingerprint retained", async () => {
    let root = dirNode(1n, {
      "was-file.md": fileNode(2n),
      "keep.md": fileNode(3n),
    });
    const { fs } = createInjectedFs(() => root);

    const built = await buildWatcherSnapshot("/", { fs });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    root = dirNode(1n, {
      "was-file.md": fileNode(4n, { kind: "other" }),
      "keep.md": fileNode(3n),
    });

    const diff = await diffWatcherSnapshot("/", built.snapshot, [""], { fs });
    expect(diff.status).toBe("ok");
    if (diff.status !== "ok") {
      return;
    }
    expect(diff.removals).toEqual(["was-file.md"]);
    expect(diff.candidates).toEqual([]);
    expectOtherFingerprint(
      diff.nextSnapshot.directories.get("")?.get("was-file.md")
    );
  });

  test("directory → other: expands nested removals, no candidate for special entry", async () => {
    let root = dirNode(1n, {
      wasDir: dirNode(2n, {
        "a.md": fileNode(3n),
        nested: dirNode(4n, {
          "b.md": fileNode(5n),
        }),
        "local.pipe": fileNode(6n, { kind: "other" }),
      }),
      "keep.md": fileNode(7n),
    });
    const { fs } = createInjectedFs(() => root);

    const built = await buildWatcherSnapshot("/", { fs });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    root = dirNode(1n, {
      wasDir: fileNode(8n, { kind: "other" }),
      "keep.md": fileNode(7n),
    });

    const diff = await diffWatcherSnapshot("/", built.snapshot, [""], { fs });
    expect(diff.status).toBe("ok");
    if (diff.status !== "ok") {
      return;
    }
    expect(diff.removals).toEqual(["wasDir/a.md", "wasDir/nested/b.md"]);
    expect(diff.candidates).toEqual([]);
    expect(diff.removals).not.toContain("wasDir");
    expect(diff.removals).not.toContain("wasDir/local.pipe");
    expectOtherFingerprint(
      diff.nextSnapshot.directories.get("")?.get("wasDir")
    );
    expect(diff.nextSnapshot.directories.has("wasDir")).toBe(false);
  });

  test("other → file: candidates the new source", async () => {
    let root = dirNode(1n, {
      "was.pipe": fileNode(2n, { kind: "other" }),
    });
    const { fs } = createInjectedFs(() => root);

    const built = await buildWatcherSnapshot("/", { fs });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }
    expectOtherFingerprint(built.snapshot.directories.get("")?.get("was.pipe"));

    root = dirNode(1n, {
      "was.pipe": fileNode(3n, { kind: "file", size: 42 }),
    });

    const diff = await diffWatcherSnapshot("/", built.snapshot, [""], { fs });
    expect(diff.status).toBe("ok");
    if (diff.status !== "ok") {
      return;
    }
    expect(diff.candidates).toEqual(["was.pipe"]);
    expect(diff.removals).toEqual([]);
    expect(diff.nextSnapshot.directories.get("")?.get("was.pipe")?.kind).toBe(
      "file"
    );
  });

  test("other → directory: scans descendants without removal", async () => {
    let root = dirNode(1n, {
      "was.pipe": fileNode(2n, { kind: "other" }),
    });
    const { fs } = createInjectedFs(() => root);

    const built = await buildWatcherSnapshot("/", { fs });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    root = dirNode(1n, {
      "was.pipe": dirNode(3n, {
        "child.md": fileNode(4n),
        deep: dirNode(5n, {
          "x.md": fileNode(6n),
        }),
        "nested.pipe": fileNode(7n, { kind: "other" }),
      }),
    });

    const diff = await diffWatcherSnapshot("/", built.snapshot, [""], { fs });
    expect(diff.status).toBe("ok");
    if (diff.status !== "ok") {
      return;
    }
    // Prior other was never indexed — no removal of was.pipe.
    expect(diff.removals).toEqual([]);
    expect(diff.candidates).toEqual([
      "was.pipe/child.md",
      "was.pipe/deep/x.md",
    ]);
    expect(diff.candidates).not.toContain("was.pipe/nested.pipe");
    expect(diff.nextSnapshot.directories.get("")?.get("was.pipe")?.kind).toBe(
      "directory"
    );
    expectOtherFingerprint(
      diff.nextSnapshot.directories.get("was.pipe")?.get("nested.pipe")
    );
  });

  test("other metadata-only change is not a candidate or removal", async () => {
    let root = dirNode(1n, {
      special: fileNode(2n, { kind: "other", size: 0 }),
    });
    const { fs } = createInjectedFs(() => root);

    const built = await buildWatcherSnapshot("/", { fs });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    root = dirNode(1n, {
      special: fileNode(2n, { kind: "other", size: 99 }),
    });

    const diff = await diffWatcherSnapshot("/", built.snapshot, [""], { fs });
    expect(diff.status).toBe("ok");
    if (diff.status !== "ok") {
      return;
    }
    expect(diff.candidates).toEqual([]);
    expect(diff.removals).toEqual([]);
    expectOtherFingerprint(
      diff.nextSnapshot.directories.get("")?.get("special")
    );
  });

  test("removed other is not a removal candidate", async () => {
    let root = dirNode(1n, {
      "gone.pipe": fileNode(2n, { kind: "other" }),
      "keep.md": fileNode(3n),
    });
    const { fs } = createInjectedFs(() => root);

    const built = await buildWatcherSnapshot("/", { fs });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    root = dirNode(1n, {
      "keep.md": fileNode(3n),
    });

    const diff = await diffWatcherSnapshot("/", built.snapshot, [""], { fs });
    expect(diff.status).toBe("ok");
    if (diff.status !== "ok") {
      return;
    }
    expect(diff.removals).toEqual([]);
    expect(diff.candidates).toEqual([]);
    expect(diff.nextSnapshot.directories.get("")?.has("gone.pipe")).toBe(false);
  });

  test("new directory scan ignores nested other and only candidates files", async () => {
    let root = dirNode(1n, {
      "keep.md": fileNode(2n),
    });
    const { fs } = createInjectedFs(() => root);

    const built = await buildWatcherSnapshot("/", { fs });
    expect(built.status).toBe("ok");
    if (built.status !== "ok") {
      return;
    }

    root = dirNode(1n, {
      "keep.md": fileNode(2n),
      added: dirNode(3n, {
        "a.md": fileNode(4n),
        sock: fileNode(5n, { kind: "other" }),
      }),
    });

    const diff = await diffWatcherSnapshot("/", built.snapshot, [""], { fs });
    expect(diff.status).toBe("ok");
    if (diff.status !== "ok") {
      return;
    }
    expect(diff.candidates).toEqual(["added/a.md"]);
    expect(diff.removals).toEqual([]);
    expectOtherFingerprint(
      diff.nextSnapshot.directories.get("added")?.get("sock")
    );
  });

  test("snapshotFingerprint helper still builds other kind for fixtures", () => {
    const fp = snapshotFingerprint("other", 9n);
    expect(fp.kind).toBe("other");
  });
});
