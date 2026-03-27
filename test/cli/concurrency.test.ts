import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { safeRm } from "../helpers/cleanup";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("CLI concurrent read/write access", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir =
      await Bun.$`mktemp -d ${join(tmpdir(), "gno-cli-concurrency.XXXXXX")}`
        .text()
        .then((value) => value.trim());
    const notesDir = join(testDir, "notes");
    await mkdir(notesDir, { recursive: true });
    await writeFile(join(notesDir, "a.md"), "# A\n\nalpha bravo charlie\n");
  });

  afterEach(async () => {
    await safeRm(testDir);
  });

  test("ls can open while update is running in another process", async () => {
    const env = {
      ...process.env,
      GNO_CONFIG_DIR: join(testDir, "config"),
      GNO_DATA_DIR: join(testDir, "data"),
      GNO_CACHE_DIR: join(testDir, "cache"),
    };

    await Bun.$`bun src/index.ts init ${join(testDir, "notes")} --name notes`
      .cwd(PROJECT_ROOT)
      .env(env)
      .quiet();

    const update = Bun.spawn({
      cmd: ["bun", "src/index.ts", "update", "--yes"],
      cwd: PROJECT_ROOT,
      env,
      stdout: "ignore",
      stderr: "ignore",
    });

    await Bun.sleep(50);

    const lsDuringUpdate = await Bun.$`bun src/index.ts ls --json`
      .cwd(PROJECT_ROOT)
      .env(env)
      .quiet()
      .text();

    await update.exited;

    const parsedDuringUpdate = JSON.parse(lsDuringUpdate) as {
      documents: Array<{ uri: string }>;
      meta: { total: number };
    };
    expect(parsedDuringUpdate.meta.total).toBeGreaterThanOrEqual(0);

    const lsAfterUpdate = await Bun.$`bun src/index.ts ls --json`
      .cwd(PROJECT_ROOT)
      .env(env)
      .quiet()
      .text();

    const parsed = JSON.parse(lsAfterUpdate) as {
      documents: Array<{ uri: string }>;
      meta: { total: number };
    };
    expect(parsed.meta.total).toBe(1);
    expect(parsed.documents[0]?.uri).toBe("gno://notes/a.md");
  });
});
