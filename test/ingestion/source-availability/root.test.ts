import { afterEach, beforeEach, expect, test } from "bun:test";
// node:fs/promises chmod/mkdir/mkdtemp: filesystem structure ops (no Bun equivalent)
import { chmod, mkdir, mkdtemp } from "node:fs/promises";
// node:os tmpdir: the per-run test temp root (no Bun equivalent)
import { tmpdir } from "node:os";
// node:path join: no Bun path utils
import { join } from "node:path";

import { createDefaultConfig } from "../../../src/config";
import {
  checkCollectionRoot,
  checkCollectionRoots,
} from "../../../src/ingestion/source-availability/root";
import { createGnoClient } from "../../../src/sdk";
import { safeRm } from "../../helpers/cleanup";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "gno-root-check-"));
});

afterEach(async () => {
  await chmod(join(tempDir, "locked"), 0o755).catch(() => undefined);
  await safeRm(tempDir);
});

test("a listable root has no error; a missing one names the error, not the path", async () => {
  const root = join(tempDir, "notes");
  const missing = await checkCollectionRoot({ path: root });
  expect(missing).toEqual({
    code: "SOURCE_AVAILABILITY_UNKNOWN",
    message:
      "Collection root is missing or unreadable (ENOENT: no such file or directory); indexed documents were kept",
  });

  await mkdir(root);
  expect(await checkCollectionRoot({ path: root })).toBeNull();
});

test("a file in place of the root is not a directory", async () => {
  const root = join(tempDir, "file.md");
  await Bun.write(root, "# not a folder\n");
  expect((await checkCollectionRoot({ path: root }))?.message).toContain(
    "ENOTDIR"
  );
  expect(
    (await checkCollectionRoot({ path: root, sourceAvailability: "local" }))
      ?.message
  ).toContain("ENOTDIR");
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "an unlistable root is unreadable, also when the collection is local-only",
  async () => {
    const root = join(tempDir, "locked");
    await mkdir(root);
    await chmod(root, 0o111);
    expect((await checkCollectionRoot({ path: root }))?.message).toContain(
      "EACCES"
    );
    // Local mode checks permissions without listing (no cloud download).
    expect(
      (await checkCollectionRoot({ path: root, sourceAvailability: "local" }))
        ?.message
    ).toContain("EACCES");
  }
);

test("checks every collection and keys errors by name", async () => {
  const present = join(tempDir, "present");
  await mkdir(present);
  expect(
    await checkCollectionRoots([
      { name: "present", path: present },
      { name: "gone", path: join(tempDir, "gone") },
      {
        name: "cloud",
        path: join(tempDir, "cloud"),
        sourceAvailability: "local",
      },
    ])
  ).toEqual({
    gone: {
      code: "SOURCE_AVAILABILITY_UNKNOWN",
      message: expect.stringContaining("ENOENT"),
    },
    cloud: {
      code: "SOURCE_AVAILABILITY_UNKNOWN",
      message: expect.stringContaining("ENOENT"),
    },
  });
});

test("SDK status marks a collection whose root is gone and clears health", async () => {
  const root = join(tempDir, "notes");
  await mkdir(root);
  const config = createDefaultConfig();
  config.collections = [
    { name: "notes", path: root, pattern: "**/*.md", include: [], exclude: [] },
  ];
  const client = await createGnoClient({
    config,
    dbPath: join(tempDir, "index.sqlite"),
  });
  try {
    const present = await client.status();
    expect(present.collections[0]?.rootError).toBeUndefined();

    await safeRm(root);
    const gone = await client.status();
    expect(gone.healthy).toBe(false);
    expect(gone.collections[0]?.rootError?.code).toBe(
      "SOURCE_AVAILABILITY_UNKNOWN"
    );
  } finally {
    await client.close();
  }
});
