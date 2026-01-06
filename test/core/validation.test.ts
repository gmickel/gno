/**
 * Core validation helpers tests.
 */

import { afterAll, describe, expect, test } from "bun:test";
// node:fs/promises for mkdtemp/symlink (no Bun equivalent for structure ops)
import { mkdtemp, symlink } from "node:fs/promises";
// node:os for tmpdir (no Bun os utils)
import { tmpdir } from "node:os";
// node:path for join, sep (no Bun path utils)
import { join, sep } from "node:path";

import {
  validateCollectionRoot,
  validateRelPath,
} from "../../src/core/validation";
import { safeRm } from "../helpers/cleanup";

const tmpRoot = await mkdtemp(join(tmpdir(), "gno-validation-"));

afterAll(async () => {
  await safeRm(tmpRoot);
});

const isWindows = process.platform === "win32";

describe("validateRelPath", () => {
  test("accepts relative path", () => {
    const result = validateRelPath("notes/test.md");
    // normalize() returns platform-native separators
    expect(result).toBe(`notes${sep}test.md`);
  });

  test("rejects absolute path", () => {
    // Use platform-appropriate absolute path
    const absPath = isWindows ? "C:\\Windows\\System32" : "/etc/passwd";
    expect(() => validateRelPath(absPath)).toThrow();
  });

  test("rejects traversal", () => {
    expect(() => validateRelPath("../escape.md")).toThrow();
  });
});

describe("validateCollectionRoot", () => {
  test("accepts safe directory", async () => {
    const realPath = await validateCollectionRoot(tmpRoot);
    expect(realPath.length).toBeGreaterThan(0);
  });

  test("rejects dangerous root", async () => {
    let error: unknown;
    try {
      await validateCollectionRoot("/");
    } catch (e) {
      error = e;
    }
    expect(error).toBeTruthy();
  });

  // Skip on Windows: /etc doesn't exist, symlink creation may need admin
  test.skipIf(isWindows)("rejects symlink to dangerous root", async () => {
    const linkPath = join(tmpRoot, "etc-link");
    await symlink("/etc", linkPath);
    let error: unknown;
    try {
      await validateCollectionRoot(linkPath);
    } catch (e) {
      error = e;
    }
    expect(error).toBeTruthy();
  });
});
