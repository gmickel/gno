/**
 * CLI write-lease contention tests (fn-127 R3, R4, R7, R10).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// node:fs/promises provides temp-directory and file writes without Bun equivalents.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
// node:os provides the temporary root.
import { tmpdir } from "node:os";
// node:path has no Bun path utilities.
import { join } from "node:path";

import { getIndexDbPath } from "../../src/app/constants";
import { runCli } from "../../src/cli/run";
import { acquireWriteLock } from "../../src/core/file-lock";
import { writeLeasePath } from "../../src/core/write-lease";
import { safeRm } from "../helpers/cleanup";

let stdoutData: string;
let stderrData: string;
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);

function captureOutput() {
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

function restoreOutput() {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
}

async function cli(
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  captureOutput();
  try {
    const code = await runCli(["node", "gno", ...args]);
    return { code, stdout: stdoutData, stderr: stderrData };
  } finally {
    restoreOutput();
  }
}

const tempRoots: string[] = [];

async function createTestDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gno-write-lease-cli-"));
  tempRoots.push(dir);
  process.env.GNO_CONFIG_DIR = join(dir, "config");
  process.env.GNO_DATA_DIR = join(dir, "data");
  process.env.GNO_CACHE_DIR = join(dir, "cache");
  await mkdir(join(dir, "data"), { recursive: true });
  return dir;
}

async function setupIndexedCollection(): Promise<void> {
  const docsDir = join(process.env.GNO_DATA_DIR ?? "", "..", "docs");
  await mkdir(docsDir, { recursive: true });
  await writeFile(
    join(docsDir, "test.md"),
    "# Test Document\n\nThis is a test markdown file for search testing.\n"
  );
  const init = await cli("init", docsDir, "--name", "docs");
  expect(init.code).toBe(0);
  const update = await cli("update");
  expect(update.code).toBe(0);
}

afterEach(async () => {
  Reflect.deleteProperty(process.env, "GNO_CONFIG_DIR");
  Reflect.deleteProperty(process.env, "GNO_DATA_DIR");
  Reflect.deleteProperty(process.env, "GNO_CACHE_DIR");
  for (const path of tempRoots.splice(0)) {
    await safeRm(path);
  }
});

describe("gno write-lease CLI", () => {
  beforeEach(async () => {
    await createTestDir();
  });

  test("index --no-wait exits 4 with the contention message (R3/R4)", async () => {
    const lock = await acquireWriteLock(
      writeLeasePath(getIndexDbPath()),
      1_000
    );
    expect(lock).not.toBeNull();
    try {
      const { code, stderr } = await cli("index", "--no-wait");
      expect(code).toBe(4);
      expect(stderr).toContain("index is busy");
      expect(stderr).toContain("held by:");
      expect(stderr).toContain("--lock-wait");
    } finally {
      await lock?.release();
    }
  });

  test("index --json --no-wait emits the contention object (R10)", async () => {
    const lock = await acquireWriteLock(
      writeLeasePath(getIndexDbPath()),
      1_000
    );
    expect(lock).not.toBeNull();
    try {
      const { code, stdout } = await cli("index", "--json", "--no-wait");
      expect(code).toBe(4);
      const parsed = JSON.parse(stdout) as {
        success: boolean;
        error: string;
        contention: {
          outcome: string;
          waitedMs: number;
          holder: string | null;
        };
      };
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("index is busy");
      expect(parsed.contention.outcome).toBe("lock_timeout");
      expect(typeof parsed.contention.waitedMs).toBe("number");
      expect(
        parsed.contention.holder === null ||
          typeof parsed.contention.holder === "string"
      ).toBe(true);
    } finally {
      await lock?.release();
    }
  });

  test("invalid --lock-wait exits 1", async () => {
    const { code, stderr } = await cli("index", "--lock-wait", "nope");
    expect(code).toBe(1);
    expect(stderr.toLowerCase()).toContain("lock-wait");
  });

  test("search still completes while the write lease is held (R7)", async () => {
    await setupIndexedCollection();
    const lock = await acquireWriteLock(
      writeLeasePath(getIndexDbPath()),
      1_000
    );
    expect(lock).not.toBeNull();
    try {
      const { code, stdout } = await cli("search", "markdown");
      expect(code).toBe(0);
      expect(stdout).toContain("test.md");
    } finally {
      await lock?.release();
    }
  }, 20_000);
});
