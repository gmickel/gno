import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../../src/cli/run";
import { createDefaultConfig, saveConfig } from "../../src/config";
import { safeRm } from "../helpers/cleanup";

let testDir: string;
let collectionDir: string;
let stdoutData = "";
let stderrData = "";

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);
const originalEnv = {
  configDir: process.env.GNO_CONFIG_DIR,
  dataDir: process.env.GNO_DATA_DIR,
  cacheDir: process.env.GNO_CACHE_DIR,
};

function captureOutput(): void {
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
  console.log = (...args: unknown[]) => {
    stdoutData += `${args.join(" ")}\n`;
  };
  console.error = (...args: unknown[]) => {
    stderrData += `${args.join(" ")}\n`;
  };
}

function restoreOutput(): void {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
}

async function cli(...args: string[]) {
  captureOutput();
  try {
    const code = await runCli(["node", "gno", ...args]);
    return { code, stdout: stdoutData, stderr: stderrData };
  } finally {
    restoreOutput();
  }
}

describe("gno index with password-protected files", () => {
  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "gno-cli-protected-files-"));
    collectionDir = join(testDir, "docs");

    await mkdir(collectionDir, { recursive: true });
    await cp(
      join(
        import.meta.dir,
        "../fixtures/conversion/pdf/password-protected.pdf"
      ),
      join(collectionDir, "password-protected.pdf")
    );
    await cp(
      join(
        import.meta.dir,
        "../fixtures/conversion/xlsx/password-protected.xlsx"
      ),
      join(collectionDir, "password-protected.xlsx")
    );
    await writeFile(join(collectionDir, "note.md"), "# Healthy note\n");

    process.env.GNO_CONFIG_DIR = join(testDir, "config-home");
    process.env.GNO_DATA_DIR = join(testDir, "data");
    process.env.GNO_CACHE_DIR = join(testDir, "cache");

    const config = createDefaultConfig();
    config.collections = [
      {
        name: "docs",
        path: collectionDir,
        pattern: "**/*",
        include: [],
        exclude: [],
      },
    ];
    const saveResult = await saveConfig(config);
    expect(saveResult.ok).toBe(true);
  });

  afterEach(async () => {
    process.env.GNO_CONFIG_DIR = originalEnv.configDir;
    process.env.GNO_DATA_DIR = originalEnv.dataDir;
    process.env.GNO_CACHE_DIR = originalEnv.cacheDir;
    await safeRm(testDir);
  });

  test("reports clean PERMISSION errors and exits successfully", async () => {
    const { code, stdout, stderr } = await cli(
      "--verbose",
      "index",
      "--no-embed"
    );

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Indexing complete.");
    expect(stdout).toContain("docs:");
    expect(stdout).toContain("1 added, 0 updated, 0 unchanged");
    expect(stdout).toContain("2 errors");
    expect(stdout).toContain(
      "[PERMISSION] password-protected.pdf: File is password-protected"
    );
    expect(stdout).toContain(
      "[PERMISSION] password-protected.xlsx: File is password-protected"
    );
    expect(stdout).not.toContain("PasswordException");
    expect(stdout).not.toContain("EncryptionInfo");
    expect(stdout).not.toContain("File is password-protected\n      at");
  });
});
