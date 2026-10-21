/**
 * `gno index <collection> --path` end to end, in an isolated GNO environment.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
// node:fs/promises, node:os, and node:path build the isolated environment.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteAdapter } from "../../src/store/sqlite/adapter";
import { safeRm } from "../helpers/cleanup";

const ENTRY = join(import.meta.dir, "../../src/index.ts");
let root = "";
let docs = "";
let env: Record<string, string>;

const gno = (...args: string[]) => {
  const run = Bun.spawnSync(["bun", ENTRY, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: run.exitCode,
    stdout: run.stdout.toString(),
    stderr: run.stderr.toString(),
  };
};

async function titles(): Promise<Record<string, string | null | boolean>> {
  const store = new SqliteAdapter();
  const opened = await store.open(
    join(env.GNO_DATA_DIR ?? "", "index-default.sqlite"),
    "snowball english"
  );
  expect(opened.ok ? "ok" : opened.error.message).toBe("ok");
  try {
    const out: Record<string, string | null | boolean> = {};
    for (const relPath of ["a.md", "b.md"]) {
      const read = await store.getDocument("notes", relPath);
      const doc = read.ok ? read.value : null;
      out[relPath] = doc?.active === false ? false : (doc?.title ?? null);
    }
    return out;
  } finally {
    await store.close();
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "gno-index-paths-"));
  docs = join(root, "docs");
  await mkdir(docs, { recursive: true });
  await writeFile(join(docs, "a.md"), "# A one\n\nalpha\n");
  await writeFile(join(docs, "b.md"), "# B one\n\nbravo\n");
  env = {
    ...(process.env as Record<string, string>),
    GNO_CONFIG_DIR: join(root, "config"),
    GNO_DATA_DIR: join(root, "data"),
    GNO_CACHE_DIR: join(root, "cache"),
    GNO_OFFLINE: "1",
  };
  expect(gno("init").code).toBe(0);
  expect(gno("collection", "add", docs, "--name", "notes").code).toBe(0);
  expect(gno("index", "notes", "--no-embed").code).toBe(0);
});

afterAll(async () => {
  await safeRm(root);
});

test("--path re-reads only the listed files and drops a deleted one", async () => {
  expect(await titles()).toEqual({ "a.md": "A one", "b.md": "B one" });
  await writeFile(join(docs, "a.md"), "# A two\n\nalpha\n");
  await writeFile(join(docs, "b.md"), "# B two\n\nbravo\n");

  const run = gno("index", "notes", "--path", "a.md", "--no-embed");
  expect(run.code).toBe(0);
  expect(await titles()).toEqual({ "a.md": "A two", "b.md": "B one" });

  await rm(join(docs, "b.md"));
  expect(gno("index", "notes", "--path", "b.md", "--no-embed").code).toBe(0);
  expect((await titles())["b.md"]).toBe(false);
});

test("invalid --path use exits 1 before writing", () => {
  for (const args of [
    ["index", "--path", "a.md", "--no-embed"],
    ["index", "notes", "--path", "../outside.md", "--no-embed"],
    ["index", "notes", "--path", "a.md", "--git-pull", "--no-embed"],
  ]) {
    const run = gno(...args);
    expect(run.code).toBe(1);
    expect(run.stderr.length).toBeGreaterThan(0);
  }
});
