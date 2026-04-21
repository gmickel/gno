/**
 * `gno daemon` backgrounding flag wiring tests (fn-72.4).
 *
 * Mirrors test/cli/serve-flags.test.ts. Exercises the Commander option
 * surface + action routing for --detach / --status / --stop / --pid-file /
 * --log-file without booting the runtime (all branches return before
 * calling `daemon()`).
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

const TEST_ROOT = join(tmpdir(), "gno-daemon-flags-test");
let counter = 0;

function getTestDir(): string {
  const dir = join(TEST_ROOT, `test-${Date.now()}-${counter}`);
  counter += 1;
  return dir;
}

describe("gno daemon backgrounding flags", () => {
  let testDir: string;
  let pidFile: string;
  let logFile: string;

  beforeEach(async () => {
    testDir = getTestDir();
    await mkdir(testDir, { recursive: true });
    process.env.GNO_CONFIG_DIR = join(testDir, "config");
    process.env.GNO_DATA_DIR = join(testDir, "data");
    process.env.GNO_CACHE_DIR = join(testDir, "cache");
    pidFile = join(testDir, "daemon.pid");
    logFile = join(testDir, "daemon.log");
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
        "daemon",
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
        "daemon",
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
        "daemon",
        "--status",
        "--pid-file",
        pidFile,
        "--log-file",
        logFile
      );
      expect(code).toBe(3);
      expect(stdout).toContain("running  no");
    });

    test("`gno daemon --status --json` matches process-status schema shape", async () => {
      const { code, stdout } = await cli(
        "daemon",
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
        // Daemon is headless — port is always null in the schema.
        port: null,
        cmd: "daemon",
        version: null,
        started_at: null,
        uptime_seconds: null,
        pid_file: pidFile,
        log_file: logFile,
        log_size_bytes: null,
      });
    });

    test("`gno --json daemon --status` (global before subcommand) also works", async () => {
      const { code, stdout } = await cli(
        "--json",
        "daemon",
        "--status",
        "--pid-file",
        pidFile,
        "--log-file",
        logFile
      );
      expect(code).toBe(3);
      const payload = JSON.parse(stdout) as Record<string, unknown>;
      expect(payload.running).toBe(false);
      expect(payload.cmd).toBe("daemon");
    });

    test("foreign-live --status --json keeps stderr a single JSON envelope", async () => {
      // Live pid (this test process), wrong gno version. statusProcess
      // flags `running:false` (version cross-check fails) AND
      // inspectForeignLive returns a signal. Stderr must remain a single
      // JSON envelope (no plain-text warning mixed in).
      await mkdir(join(testDir, "data"), { recursive: true });
      const payload = {
        pid: process.pid,
        cmd: "daemon",
        version: "0.0.0-foreign-test",
        started_at: new Date().toISOString(),
        // Daemon pid-files do not record a port — store null to match the
        // detach helper's writePidFile path.
        port: null,
      };
      await writeFile(pidFile, `${JSON.stringify(payload)}\n`);

      const { code, stdout, stderr } = await cli(
        "daemon",
        "--status",
        "--json",
        "--pid-file",
        pidFile,
        "--log-file",
        logFile
      );
      expect(code).toBe(3);

      const statusPayload = JSON.parse(stdout) as Record<string, unknown>;
      expect(statusPayload.running).toBe(false);
      expect(statusPayload.cmd).toBe("daemon");

      const stderrTrimmed = stderr.trim();
      expect(() => JSON.parse(stderrTrimmed)).not.toThrow();
      const envelope = JSON.parse(stderrTrimmed) as {
        error: { code: string; details?: { foreign_live?: unknown } };
      };
      expect(envelope.error.code).toBe("NOT_RUNNING");
      expect(envelope.error.details?.foreign_live).toMatchObject({
        pid: process.pid,
        recorded_version: "0.0.0-foreign-test",
      });
    });

    test("exits 0 when pid-file points at a live matching process", async () => {
      await mkdir(join(testDir, "data"), { recursive: true });
      const { VERSION } = await import("../../src/app/constants");
      const payload = {
        pid: process.pid,
        cmd: "daemon",
        version: VERSION,
        started_at: new Date().toISOString(),
        port: null,
      };
      await writeFile(pidFile, `${JSON.stringify(payload)}\n`);

      const { code, stdout } = await cli(
        "daemon",
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
      // Headless — never a numeric port even if one were present.
      expect(parsed.port).toBeNull();
    });
  });

  describe("--stop", () => {
    test("exits 3 silently when no pid-file exists", async () => {
      const { code, stdout, stderr } = await cli(
        "daemon",
        "--stop",
        "--pid-file",
        pidFile,
        "--log-file",
        logFile
      );
      expect(code).toBe(3);
      expect(stdout).toBe("");
      expect(stderr).toBe("");
    });

    test("exits 3 when pid-file is stale (dead pid)", async () => {
      // Pick a pid well over default Linux pid_max (32768) so it's
      // overwhelmingly unlikely to be a live process on the host.
      await mkdir(join(testDir, "data"), { recursive: true });
      const { VERSION } = await import("../../src/app/constants");
      const payload = {
        pid: 4_194_303,
        cmd: "daemon",
        version: VERSION,
        started_at: new Date().toISOString(),
        port: null,
      };
      await writeFile(pidFile, `${JSON.stringify(payload)}\n`);

      const { code } = await cli(
        "daemon",
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
    test("`--json` with `--stop` is rejected (exit 1)", async () => {
      const { code, stderr } = await cli(
        "daemon",
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

    test("`--json` with `--detach` is rejected before runtime boot", async () => {
      // Pair --json with --detach so we don't accidentally boot the runtime;
      // validation should fire before the detach branch.
      const { code, stderr } = await cli(
        "daemon",
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
      const customPid = join(testDir, "custom-daemon.pid");
      const customLog = join(testDir, "custom-daemon.log");
      const { stdout } = await cli(
        "daemon",
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
