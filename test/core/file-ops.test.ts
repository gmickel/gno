/**
 * Core file ops tests.
 */

import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises for mkdtemp (no Bun equivalent for structure ops)
import { mkdtemp, writeFile } from "node:fs/promises";
// node:os for tmpdir (no Bun os utils)
import { tmpdir } from "node:os";
// node:path for join (no Bun path utils)
import { join } from "node:path";

import { atomicWrite, trashFilePath } from "../../src/core/file-ops";
import { safeRm } from "../helpers/cleanup";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const path of tempDirs.splice(0)) {
    await safeRm(path);
  }
});

describe("atomicWrite", () => {
  test("writes content to target file", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "gno-atomic-"));
    tempDirs.push(tempDir);
    const targetPath = join(tempDir, "note.md");

    await atomicWrite(targetPath, "hello");
    const content = await Bun.file(targetPath).text();
    expect(content).toBe("hello");
  });
});

describe("trashFilePath", () => {
  test("moves files into ~/.Trash on darwin without external trash CLI", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "gno-trash-darwin-"));
    tempDirs.push(workspaceDir);
    const homeDir = join(workspaceDir, "home");
    const sourcePath = join(workspaceDir, "note.md");
    await writeFile(sourcePath, "hello");

    await trashFilePath(sourcePath, {
      homeDir,
      platform: "darwin",
    });

    expect(await Bun.file(sourcePath).exists()).toBe(false);
    expect(await Bun.file(join(homeDir, ".Trash", "note.md")).exists()).toBe(
      true
    );
  });

  test("moves files into freedesktop trash on linux without external trash CLI", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "gno-trash-linux-"));
    tempDirs.push(workspaceDir);
    const homeDir = join(workspaceDir, "home");
    const sourcePath = join(workspaceDir, "note.md");
    await writeFile(sourcePath, "hello");

    await trashFilePath(sourcePath, {
      homeDir,
      platform: "linux",
    });

    const trashedPath = join(
      homeDir,
      ".local",
      "share",
      "Trash",
      "files",
      "note.md"
    );
    const infoPath = join(
      homeDir,
      ".local",
      "share",
      "Trash",
      "info",
      "note.md.trashinfo"
    );

    expect(await Bun.file(sourcePath).exists()).toBe(false);
    expect(await Bun.file(trashedPath).exists()).toBe(true);
    const info = await Bun.file(infoPath).text();
    expect(info).toContain("[Trash Info]");
    expect(info).toContain("Path=");
    expect(info).toContain("DeletionDate=");
  });
});
