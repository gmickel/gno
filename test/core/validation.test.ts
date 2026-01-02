/**
 * Core validation helpers tests.
 */

import { afterAll, describe, expect, test } from "bun:test";
// node:fs/promises for mkdtemp/symlink/rm (no Bun equivalent for structure ops)
import { mkdtemp, rm, symlink } from "node:fs/promises";
// node:os for tmpdir (no Bun os utils)
import { tmpdir } from "node:os";
// node:path for join (no Bun path utils)
import { join } from "node:path";

import {
  validateCollectionRoot,
  validateRelPath,
} from "../../src/core/validation";

const tmpRoot = await mkdtemp(join(tmpdir(), "gno-validation-"));

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("validateRelPath", () => {
  test("accepts relative path", () => {
    const result = validateRelPath("notes/test.md");
    expect(result).toBe("notes/test.md");
  });

  test("rejects absolute path", () => {
    expect(() => validateRelPath("/etc/passwd")).toThrow();
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

  test("rejects symlink to dangerous root", async () => {
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
