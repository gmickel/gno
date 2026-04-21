/**
 * `gno serve` backgrounding flag wiring tests (fn-72.3).
 *
 * Exercises the Commander option surface + action routing for
 * --detach / --status / --stop / --pid-file / --log-file without
 * actually booting the server runtime (all branches return before
 * calling `startServer`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../../src/cli/run";
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

const TEST_ROOT = join(tmpdir(), "gno-serve-flags-test");
let counter = 0;

function getTestDir(): string {
  const dir = join(TEST_ROOT, `test-${Date.now()}-${counter}`);
  counter += 1;
  return dir;
}

describe("gno serve backgrounding flags", () => {
  let testDir: string;
  let pidFile: string;
  let logFile: string;

  beforeEach(async () => {
    testDir = getTestDir();
    await mkdir(testDir, { recursive: true });
    process.env.GNO_CONFIG_DIR = join(testDir, "config");
    process.env.GNO_DATA_DIR = join(testDir, "data");
    process.env.GNO_CACHE_DIR = join(testDir, "cache");
    pidFile = join(testDir, "serve.pid");
    logFile = join(testDir, "serve.log");
  });

  afterEach(async () => {
    await safeRm(testDir);
    Reflect.deleteProperty(process.env, "GNO_CONFIG_DIR");
    Reflect.deleteProperty(process.env, "GNO_DATA_DIR");
    Reflect.deleteProperty(process.env, "GNO_CACHE_DIR");
  });

  describe("mutual exclusion", () => {
    test("--detach and --status conflict (exit 1)", async () => {
      const { code, stderr } = await cli(
        "serve",
        "--detach",
        "--status",
        "--pid-file",
        pidFile,
        "--log-file",
        logFile
      );
      expect(code).toBe(1);
      expect(stderr).toContain("--detach");
      expect(stderr).toContain("--status");
    });

    test("--status and --stop conflict (exit 1)", async () => {
      const { code, stderr } = await cli(
        "serve",
        "--status",
        "--stop",
        "--pid-file",
        pidFile,
        "--log-file",
        logFile
      );
      expect(code).toBe(1);
      expect(stderr).toContain("--status");
      expect(stderr).toContain("--stop");
    });
  });

  describe("--status", () => {
    test("exits 3 when no pid-file exists", async () => {
      const { code, stdout } = await cli(
        "serve",
        "--status",
        "--pid-file",
        pidFile,
        "--log-file",
        logFile
      );
      expect(code).toBe(3);
      expect(stdout).toContain("running  no");
    });

    test("`gno serve --status --json` matches process-status schema shape", async () => {
      // Documented invocation order: subcommand flag, then --json.
      const { code, stdout } = await cli(
        "serve",
        "--status",
        "--json",
        "--pid-file",
        pidFile,
        "--log-file",
        logFile
      );
      expect(code).toBe(3);
      const payload = JSON.parse(stdout) as Record<string, unknown>;
      expect(payload).toMatchObject({
        running: false,
        pid: null,
        port: null,
        cmd: "serve",
        version: null,
        started_at: null,
        uptime_seconds: null,
        pid_file: pidFile,
        log_file: logFile,
        log_size_bytes: null,
      });
    });

    test("`gno --json serve --status` (global before subcommand) also works", async () => {
      const { code, stdout } = await cli(
        "--json",
        "serve",
        "--status",
        "--pid-file",
        pidFile,
        "--log-file",
        logFile
      );
      expect(code).toBe(3);
      const payload = JSON.parse(stdout) as Record<string, unknown>;
      expect(payload.running).toBe(false);
      expect(payload.cmd).toBe("serve");
    });

    test("exits 0 when pid-file points at a live matching process", async () => {
      // The current bun test runner is itself a live PID we can safely
      // probe with kill(0). Write a pid-file claiming ownership by this
      // PID so statusProcess sees running:true. We can't use the real
      // gno VERSION constant without importing it, but we can read it
      // back from the schema path through the CLI.
      await mkdir(join(testDir, "data"), { recursive: true });
      const { VERSION } = await import("../../src/app/constants");
      const payload = {
        pid: process.pid,
        cmd: "serve",
        version: VERSION,
        started_at: new Date().toISOString(),
        port: 3333,
      };
      await writeFile(pidFile, `${JSON.stringify(payload)}\n`);

      const { code, stdout } = await cli(
        "serve",
        "--status",
        "--json",
        "--pid-file",
        pidFile,
        "--log-file",
        logFile
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      expect(parsed.running).toBe(true);
      expect(parsed.pid).toBe(process.pid);
      expect(parsed.port).toBe(3333);
    });
  });

  describe("--stop", () => {
    test("exits 3 when no pid-file exists", async () => {
      const { code, stderr } = await cli(
        "serve",
        "--stop",
        "--pid-file",
        pidFile,
        "--log-file",
        logFile
      );
      expect(code).toBe(3);
      expect(stderr).toContain("not running");
    });

    test("exits 3 when pid-file is stale (dead pid)", async () => {
      // Fabricate a stale pid-file pointing at PID 1 owner mismatch via
      // a clearly dead pid. We pick 2**22 (well over Linux default
      // pid_max of 32768 on test machines; if the CI host has higher
      // pid_max this is still very unlikely to be live).
      await mkdir(join(testDir, "data"), { recursive: true });
      const { VERSION } = await import("../../src/app/constants");
      const payload = {
        pid: 4_194_303,
        cmd: "serve",
        version: VERSION,
        started_at: new Date().toISOString(),
        port: 3333,
      };
      await writeFile(pidFile, `${JSON.stringify(payload)}\n`);

      const { code } = await cli(
        "serve",
        "--stop",
        "--pid-file",
        pidFile,
        "--log-file",
        logFile
      );
      expect(code).toBe(3);
    });
  });

  describe("--json gated to --status", () => {
    test("`--json` without `--status` is rejected (exit 1)", async () => {
      const { code, stderr } = await cli(
        "serve",
        "--stop",
        "--json",
        "--pid-file",
        pidFile,
        "--log-file",
        logFile
      );
      expect(code).toBe(1);
      expect(stderr).toContain("--json");
      expect(stderr).toContain("--status");
    });

    test("`--json` alone (no --status) is rejected before runtime boot", async () => {
      // We don't want the foreground server to actually start during the
      // test, so pair --json with --detach which short-circuits; the
      // validation should fire before the detach branch.
      const { code, stderr } = await cli(
        "serve",
        "--detach",
        "--json",
        "--pid-file",
        pidFile,
        "--log-file",
        logFile
      );
      expect(code).toBe(1);
      expect(stderr).toContain("--json");
    });
  });

  describe("--pid-file / --log-file override", () => {
    test("status reports user-supplied absolute paths verbatim", async () => {
      const customPid = join(testDir, "custom.pid");
      const customLog = join(testDir, "custom.log");
      const { stdout } = await cli(
        "serve",
        "--status",
        "--json",
        "--pid-file",
        customPid,
        "--log-file",
        customLog
      );
      const payload = JSON.parse(stdout) as Record<string, unknown>;
      expect(payload.pid_file).toBe(customPid);
      expect(payload.log_file).toBe(customLog);
    });
  });
});
