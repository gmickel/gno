/**
 * Core file ops tests.
 */

import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises for mkdtemp/rm (no Bun equivalent for structure ops)
import { mkdtemp, rm } from "node:fs/promises";
// node:os for tmpdir (no Bun os utils)
import { tmpdir } from "node:os";
// node:path for join (no Bun path utils)
import { join } from "node:path";

import { atomicWrite } from "../../src/core/file-ops";

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("atomicWrite", () => {
  test("writes content to target file", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "gno-atomic-"));
    const targetPath = join(tempDir, "note.md");

    await atomicWrite(targetPath, "hello");
    const content = await Bun.file(targetPath).text();
    expect(content).toBe("hello");
  });
});
