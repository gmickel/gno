/**
 * fn-209: snapshot classification of a dirty directory also removes notes
 * the store has active under it but the snapshot never saw. A note indexed
 * from its own exact watcher event after the baseline is in the store, not in
 * the snapshot; when its directory is then moved or deleted (one directory
 * event), the snapshot diff alone left it active forever.
 */

import { expect, test } from "bun:test";
// node:fs/promises — structural fixture operations have no Bun equivalent.
import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
// node:os — Bun has no temp-directory helper.
import { tmpdir } from "node:os";
// node:path — Bun has no path utilities.
import { join } from "node:path";

import type { Collection } from "../../src/config/types";
import type { SqliteAdapter } from "../../src/store/sqlite/adapter";

import { classifyDirtyHints } from "../../src/serve/watch-reconciliation";
import { buildWatcherSnapshot } from "../../src/serve/watch-snapshot";
import { safeRm } from "../helpers/cleanup";
import { createPortableWatcherFs } from "./helpers/watch-portable-fixtures";

const collection = (root: string): Collection => ({
  name: "notes",
  path: root,
  pattern: "**/*.md",
  include: [],
  exclude: [],
});

/** Store whose active inventory includes notes the snapshot never scanned. */
function storeWith(active: string[]): SqliteAdapter {
  return {
    listActiveDirectChildSourcePaths: async () => ({ ok: true, value: [] }),
    listActiveSourcePaths: async () => ({ ok: true, value: active }),
    listActiveDescendantSourcePaths: async (
      _collection: string,
      dir: string
    ) => ({
      ok: true,
      value: active.filter((path) => path.startsWith(`${dir}/`)),
    }),
  } as unknown as SqliteAdapter;
}

async function baseline(root: string) {
  const built = await buildWatcherSnapshot(root, {
    fs: createPortableWatcherFs(),
  });
  if (built.status !== "ok") throw new Error("snapshot required");
  return built.snapshot;
}

test("a moved directory removes notes indexed after the baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "gno-watch-store-removals-"));
  try {
    await mkdir(join(root, "d4"), { recursive: true });
    await writeFile(join(root, "d4", "old.md"), "old");
    const previous = await baseline(root);
    // Indexed later from its own event; the snapshot was not refreshed.
    await writeFile(join(root, "d4", "new.md"), "new");
    await rename(join(root, "d4"), join(root, "d4x"));

    const classified = await classifyDirtyHints({
      snapshotOptions: { fs: createPortableWatcherFs() },
      collection: collection(root),
      store: storeWith(["d4/new.md", "d4/old.md"]),
      rootAbs: root,
      previous,
      dirtyHints: ["d4", "d4x"],
    });
    expect(classified.status).toBe("ok");
    if (classified.status !== "ok") throw new Error("expected ok");
    expect(classified.removals.sort()).toEqual(["d4/new.md", "d4/old.md"]);
    expect(classified.candidates.sort()).toEqual(["d4x/new.md", "d4x/old.md"]);
  } finally {
    await safeRm(root);
  }
});

test("a replaced directory removes store-only notes and keeps notes still on disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "gno-watch-store-removals-"));
  try {
    await mkdir(join(root, "d4"), { recursive: true });
    await writeFile(join(root, "d4", "old.md"), "old");
    await writeFile(join(root, "d4", "kept.md"), "kept");
    const previous = await baseline(root);
    await writeFile(join(root, "d4", "new.md"), "new");
    await writeFile(join(root, "d4", "later.md"), "later");
    // new.md goes away; later.md (also store-only) stays.
    await safeRm(join(root, "d4", "new.md"));

    const classified = await classifyDirtyHints({
      snapshotOptions: { fs: createPortableWatcherFs() },
      collection: collection(root),
      store: storeWith(["d4/kept.md", "d4/later.md", "d4/new.md", "d4/old.md"]),
      rootAbs: root,
      previous,
      dirtyHints: ["d4"],
    });
    expect(classified.status).toBe("ok");
    if (classified.status !== "ok") throw new Error("expected ok");
    expect(classified.removals).toContain("d4/new.md");
    expect(classified.removals).not.toContain("d4/later.md");
    expect(classified.removals).not.toContain("d4/kept.md");
  } finally {
    await safeRm(root);
  }
});
