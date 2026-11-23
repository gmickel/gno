/**
 * `gno collection move` through the real CLI: receipt, exit codes, the
 * mapping file, and the write lease.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// node:fs/promises for mkdir/rename (filesystem structure ops)
import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises";
// Bun has no temporary-directory or path API.
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { getIndexDbPath, resolveDirs } from "../../src/app/constants";
import { safeRm } from "../helpers/cleanup";
import { assertValid, loadSchema } from "../spec/schemas/validator";

const PROJECT_ROOT = resolve(import.meta.dir, "../..");

let root: string;
let env: Record<string, string | undefined>;

const gno = async (...args: string[]) => {
  const proc = Bun.spawn({
    cmd: ["bun", "src/index.ts", ...args],
    cwd: PROJECT_ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
};

const put = async (relPath: string, text: string) => {
  await mkdir(dirname(join(root, relPath)), { recursive: true });
  await writeFile(join(root, relPath), text);
};

const mv = async (from: string, to: string) => {
  await mkdir(dirname(join(root, to)), { recursive: true });
  await rename(join(root, from), join(root, to));
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "gno-collection-move-"));
  env = {
    ...process.env,
    GNO_CONFIG_DIR: join(root, "config"),
    GNO_DATA_DIR: join(root, "data-dir"),
    GNO_CACHE_DIR: join(root, "cache"),
    NO_COLOR: "1",
  };
  await put("notes/reports/q1.md", "# Q1\n\nThe zanzibar figures.\n");
  await put("notes/reports/q2.md", "# Q2\n\nMore figures.\n");
  await put("notes/a.md", "# A\n");
  await put("notes/b.md", "# B\n");
  await mkdir(join(root, "data"), { recursive: true });
  expect((await gno("init")).code).toBe(0);
  expect(
    (await gno("collection", "add", join(root, "notes"), "--name", "notes"))
      .code
  ).toBe(0);
  expect(
    (await gno("collection", "add", join(root, "data"), "--name", "data")).code
  ).toBe(0);
  expect((await gno("update")).code).toBe(0);
}, 60_000);

afterAll(async () => {
  await safeRm(root);
});

describe("gno collection move", () => {
  test("moves a folder with a JSON receipt; update afterwards adds nothing", async () => {
    await mv("notes/reports", "data/reports");
    const dry = await gno(
      "collection",
      "move",
      "notes/reports/",
      "data/reports/",
      "--dry-run",
      "--json"
    );
    expect(dry.code).toBe(0);
    expect(JSON.parse(dry.stdout)).toMatchObject({
      dryRun: true,
      relocated: 2,
    });

    const moved = await gno(
      "collection",
      "move",
      "notes/reports/",
      "data/reports/",
      "--json"
    );
    expect(moved.code).toBe(0);
    const receipt = JSON.parse(moved.stdout);
    expect(assertValid(receipt, await loadSchema("collection-move"))).toBe(
      true
    );
    expect(receipt).toMatchObject({ dryRun: false, relocated: 2, refused: 0 });

    const update = await gno("update", "--json");
    expect(update.code).toBe(0);
    const sync = JSON.parse(update.stdout);
    expect(sync.totalFilesAdded).toBe(0);
    expect(sync.totalFilesUpdated).toBe(0);
    for (const collection of sync.collections) {
      expect(collection.filesMarkedInactive).toBe(0);
    }

    const search = await gno("search", "zanzibar", "-c", "data", "--json");
    expect(search.stdout).toContain("gno://data/reports/q1.md");
    const old = await gno("search", "zanzibar", "-c", "notes", "--json");
    expect(old.stdout).not.toContain("q1.md");
  }, 60_000);

  test("a refused item exits 1 and still prints the receipt", async () => {
    const result = await gno(
      "collection",
      "move",
      "notes/a.md",
      "data",
      "--json"
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).items[0]).toMatchObject({
      status: "refused",
      code: "DESTINATION_MISSING",
    });
  }, 30_000);

  test("a mapping file moves several documents in one run", async () => {
    await mv("notes/a.md", "data/x/a.md");
    await mv("notes/b.md", "data/x/b.md");
    const map = join(root, "moves.tsv");
    await writeFile(
      map,
      "# source\tdestination\nnotes/a.md\tdata/x/\nnotes/b.md\tdata/x/b.md\n"
    );
    const result = await gno(
      "collection",
      "move",
      "--from-file",
      map,
      "--json"
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      relocated: 2,
      refused: 0,
    });
  }, 30_000);

  test("waits for, or with --no-wait refuses, a held write lease", async () => {
    const dbPath = getIndexDbPath(undefined, {
      ...resolveDirs(),
      data: join(root, "data-dir"),
    });
    const holder = Bun.spawn({
      cmd: [
        "bun",
        "test/fixtures/write-lease-holder.ts",
        "lease",
        dbPath,
        "5000",
        "gno update",
      ],
      cwd: PROJECT_ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = holder.stdout.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("ready");
    try {
      const busy = await gno(
        "collection",
        "move",
        "data/x/a.md",
        "notes",
        "--no-wait",
        "--json"
      );
      expect(busy.code).toBe(4);
      expect(busy.stdout + busy.stderr).toContain("gno update");
    } finally {
      holder.kill();
      await holder.exited;
    }
  }, 30_000);
});
