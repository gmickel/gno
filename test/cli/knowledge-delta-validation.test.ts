import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../../src/cli/run";
import { safeRm } from "../helpers/cleanup";

let stdoutData = "";
let stderrData = "";
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

const cli = async (
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> => {
  stdoutData = "";
  stderrData = "";
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdoutData += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderrData += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  try {
    const code = await runCli(["bun", "gno", ...args]);
    return { code, stdout: stdoutData, stderr: stderrData };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
};

describe("Knowledge Delta CLI selector validation", () => {
  let testDir = "";

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "gno-delta-cli-validation-"));
    const docsDir = join(testDir, "docs");
    await mkdir(docsDir);
    process.env.GNO_CONFIG_DIR = join(testDir, "config");
    process.env.GNO_DATA_DIR = join(testDir, "data");
    process.env.GNO_CACHE_DIR = join(testDir, "cache");
    expect((await cli("init", docsDir, "--name", "notes")).code).toBe(0);
  });

  afterEach(async () => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    Reflect.deleteProperty(process.env, "GNO_CONFIG_DIR");
    Reflect.deleteProperty(process.env, "GNO_DATA_DIR");
    Reflect.deleteProperty(process.env, "GNO_CACHE_DIR");
    await safeRm(testDir);
  });

  test("fails closed for provided-empty collection and change selectors", async () => {
    const changes = await cli("changes", "--collection", "", "--json");
    expect(changes.code).toBe(1);
    expect(changes.stderr).toContain("collection");

    const diff = await cli(
      "diff",
      "gno://notes/missing.md",
      "--change",
      "   ",
      "--json"
    );
    expect(diff.code).toBe(1);
    expect(diff.stderr).toContain("changeId");
  });
});
