/**
 * Core file ops tests.
 */

import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises for mkdtemp/symlink (no Bun equivalent for structure ops)
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
// node:os for tmpdir/platform (no Bun os utils)
import { platform, tmpdir } from "node:os";
// node:path for join (no Bun path utils)
import { join } from "node:path";

import {
  atomicCreate,
  atomicWrite,
  backupFileToSibling,
  restoreFileFromBackup,
  trashFilePath,
  writeStagedFileContent,
} from "../../src/core/file-ops";
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

describe("exclusive stage/backup and symlink-safe restore", () => {
  test("writeStagedFileContent and backupFileToSibling fail closed on pre-existing symlink", async () => {
    if (platform() === "win32") return;
    const tempDir = await mkdtemp(join(tmpdir(), "gno-excl-"));
    tempDirs.push(tempDir);
    const outside = await mkdtemp(join(tmpdir(), "gno-excl-out-"));
    tempDirs.push(outside);
    const sentinel = join(outside, "sentinel.md");
    await Bun.write(sentinel, "OUTSIDE\n");
    const source = join(tempDir, "note.md");
    await Bun.write(source, "ORIGINAL\n");
    const stage = join(tempDir, "note.md.gno-rf-stage.t");
    const backup = join(tempDir, "note.md.gno-rf-backup.t");
    await symlink(sentinel, stage);
    await symlink(sentinel, backup);

    let stageFailed = false;
    try {
      await writeStagedFileContent(stage, "STAGE\n");
    } catch {
      stageFailed = true;
    }
    let backupFailed = false;
    try {
      await backupFileToSibling(source, backup);
    } catch {
      backupFailed = true;
    }
    expect(stageFailed).toBe(true);
    expect(backupFailed).toBe(true);
    expect(await Bun.file(sentinel).text()).toBe("OUTSIDE\n");
    expect(await Bun.file(source).text()).toBe("ORIGINAL\n");
  });

  test("atomicCreate succeeds exclusively then EEXIST on retry", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "gno-excl-ok-"));
    tempDirs.push(tempDir);
    const path = join(tempDir, "created.md");
    await atomicCreate(path, "one");
    expect(await Bun.file(path).text()).toBe("one");
    let secondFailed = false;
    try {
      await atomicCreate(path, "two");
    } catch {
      secondFailed = true;
    }
    expect(secondFailed).toBe(true);
    expect(await Bun.file(path).text()).toBe("one");
  });

  test("restoreFileFromBackup replaces a symlink path without following it", async () => {
    if (platform() === "win32") return;
    const tempDir = await mkdtemp(join(tmpdir(), "gno-restore-"));
    tempDirs.push(tempDir);
    const outside = await mkdtemp(join(tmpdir(), "gno-restore-out-"));
    tempDirs.push(outside);
    const sentinel = join(outside, "sentinel.md");
    await Bun.write(sentinel, "OUTSIDE\n");
    const backup = join(tempDir, "note.md.gno-rf-backup.t");
    const target = join(tempDir, "note.md");
    await Bun.write(backup, "RESTORED\n");
    await symlink(sentinel, target);

    await restoreFileFromBackup(backup, target);
    expect(await Bun.file(target).text()).toBe("RESTORED\n");
    expect(await Bun.file(sentinel).text()).toBe("OUTSIDE\n");
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
