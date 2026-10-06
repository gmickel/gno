/**
 * fn-204: config sync at startup (stdio `gno mcp`, CLI, resident) must not
 * fail with "database is locked" when another process commits a write while
 * it runs. A deferred read-then-write transaction cannot be retried once
 * another connection commits (SQLITE_BUSY_SNAPSHOT); taking the write lock
 * up front lets the busy timeout wait instead.
 */

import { afterEach, expect, test } from "bun:test";
// node:fs/promises — mkdtemp is a directory-structure op
import { mkdtemp } from "node:fs/promises";
// node:os — tmpdir has no Bun equivalent
import { tmpdir } from "node:os";
// node:path — Bun has no path utilities
import { join } from "node:path";

import type { Collection } from "../../src/config/types";

import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

const roots: string[] = [];
const stores: SqliteAdapter[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) await safeRm(root);
});

const collection = (name: string, path: string): Collection => ({
  name,
  path,
  pattern: "**/*.md",
  include: [],
  exclude: [],
});

/** Another process takes the write lock, writes, then commits after `holdMs`. */
async function concurrentWriter(dbPath: string, holdMs: number) {
  const script = `
    import { Database } from "bun:sqlite";
    const db = new Database(${JSON.stringify(dbPath)});
    db.exec("BEGIN IMMEDIATE");
    db.run("INSERT INTO schema_meta (key, value) VALUES ('fn-204-probe', '1') ON CONFLICT(key) DO UPDATE SET value = value || '1'");
    console.log("LOCKED");
    await Bun.sleep(${holdMs});
    db.exec("COMMIT");
    db.close();
  `;
  const proc = Bun.spawn({
    cmd: [process.execPath, "-e", script],
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = proc.stdout.getReader();
  const { value } = await reader.read();
  expect(new TextDecoder().decode(value)).toContain("LOCKED");
  return proc;
}

test("syncCollections waits out a concurrent writer instead of failing", async () => {
  const root = await mkdtemp(join(tmpdir(), "gno-fn204-"));
  roots.push(root);
  const dbPath = join(root, "index.sqlite");
  const store = new SqliteAdapter();
  stores.push(store);
  expect((await store.open(dbPath, "porter", 5_000)).ok).toBe(true);
  expect(
    (await store.syncCollections([collection("a", join(root, "a"))])).ok
  ).toBe(true);

  const writer = await concurrentWriter(dbPath, 400);
  // Starts while the other process holds the write lock and commits under it.
  const result = await store.syncCollections([
    collection("a", join(root, "a")),
    collection("b", join(root, "b")),
  ]);
  await writer.exited;

  expect(result.ok ? "ok" : result.error.message).toBe("ok");
  const names = store
    .getRawDb()
    .query<{ name: string }, []>("SELECT name FROM collections ORDER BY name")
    .all()
    .map((row) => row.name);
  expect(names).toEqual(["a", "b"]);
});
