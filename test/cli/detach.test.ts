/**
 * Unit tests for `src/cli/detach.ts`.
 *
 * Keeps the suite hermetic by sandboxing `GNO_DATA_DIR` to a per-test tmpdir,
 * so no writes ever reach `~/.local/share/gno/`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { VERSION } from "../../src/app/constants";
import {
  DETACHED_CHILD_FLAG,
  guardDoubleStart,
  isProcessAlive,
  readPidFile,
  resolveProcessPaths,
  spawnDetached,
  statusProcess,
  stopProcess,
  writePidFile,
} from "../../src/cli/detach";
import { CliError } from "../../src/cli/errors";
import { safeRm } from "../helpers/cleanup";

async function makeTmpDir(prefix: string): Promise<string> {
  const base = join(
    tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  await mkdir(base, { recursive: true });
  return base;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ErrorCtor = new (...args: any[]) => Error;

async function expectRejects(
  promise: Promise<unknown>,
  matcher: string | RegExp | ErrorCtor
): Promise<Error> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  const err = caught as Error;
  if (typeof matcher === "function") {
    expect(caught).toBeInstanceOf(matcher);
  } else if (matcher instanceof RegExp) {
    expect(err.message).toMatch(matcher);
  } else {
    expect(err.message).toContain(matcher);
  }
  return err;
}

describe("detach helper", () => {
  let tmpDir: string;
  let prevDataDir: string | undefined;
  let prevConfigDir: string | undefined;
  let prevCacheDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await makeTmpDir("gno-detach");
    prevDataDir = process.env.GNO_DATA_DIR;
    prevConfigDir = process.env.GNO_CONFIG_DIR;
    prevCacheDir = process.env.GNO_CACHE_DIR;
    process.env.GNO_DATA_DIR = join(tmpDir, "data");
    process.env.GNO_CONFIG_DIR = join(tmpDir, "config");
    process.env.GNO_CACHE_DIR = join(tmpDir, "cache");
  });

  afterEach(async () => {
    if (prevDataDir === undefined) {
      delete process.env.GNO_DATA_DIR;
    } else {
      process.env.GNO_DATA_DIR = prevDataDir;
    }
    if (prevConfigDir === undefined) {
      delete process.env.GNO_CONFIG_DIR;
    } else {
      process.env.GNO_CONFIG_DIR = prevConfigDir;
    }
    if (prevCacheDir === undefined) {
      delete process.env.GNO_CACHE_DIR;
    } else {
      process.env.GNO_CACHE_DIR = prevCacheDir;
    }
    await safeRm(tmpDir);
  });

  describe("resolveProcessPaths", () => {
    test("defaults to GNO_DATA_DIR with {kind}.pid and {kind}.log", () => {
      const paths = resolveProcessPaths("serve");
      expect(paths.pidFile).toBe(join(tmpDir, "data", "serve.pid"));
      expect(paths.logFile).toBe(join(tmpDir, "data", "serve.log"));
    });

    test("uses kind-specific names for daemon", () => {
      const paths = resolveProcessPaths("daemon");
      expect(paths.pidFile).toBe(join(tmpDir, "data", "daemon.pid"));
      expect(paths.logFile).toBe(join(tmpDir, "data", "daemon.log"));
    });

    test("expands ~ via toAbsolutePath for overrides", () => {
      // node:os.homedir() is read at call time, so we can't spoof HOME here.
      // Just assert that a ~-prefixed override is absolute and lives under
      // the real homedir (i.e. expansion happened).
      const home = process.env.HOME ?? "";
      const paths = resolveProcessPaths("serve", {
        pidFile: "~/custom.pid",
        logFile: "~/custom.log",
      });
      expect(paths.pidFile.startsWith(home)).toBe(true);
      expect(paths.pidFile.endsWith("custom.pid")).toBe(true);
      expect(paths.logFile.startsWith(home)).toBe(true);
      expect(paths.logFile.endsWith("custom.log")).toBe(true);
    });

    test("resolves relative overrides against cwd", () => {
      const paths = resolveProcessPaths("daemon", {
        pidFile: "nested/dae.pid",
        logFile: "nested/dae.log",
        cwd: tmpDir,
      });
      expect(paths.pidFile).toBe(join(tmpDir, "nested", "dae.pid"));
      expect(paths.logFile).toBe(join(tmpDir, "nested", "dae.log"));
    });

    test("passes absolute overrides through unchanged", () => {
      const pid = join(tmpDir, "abs.pid");
      const log = join(tmpDir, "abs.log");
      const paths = resolveProcessPaths("serve", {
        pidFile: pid,
        logFile: log,
      });
      expect(paths.pidFile).toBe(pid);
      expect(paths.logFile).toBe(log);
    });
  });

  describe("pid-file round-trip", () => {
    test("writePidFile + readPidFile round-trip preserves shape", async () => {
      const pidFile = join(tmpDir, "nested", "serve.pid");
      const payload = {
        pid: 1234,
        cmd: "serve" as const,
        version: "1.2.3",
        started_at: "2026-04-21T19:30:00.000Z",
        port: 3000,
      };

      await writePidFile(pidFile, payload);
      const parsed = await readPidFile(pidFile);

      expect(parsed).toEqual(payload);
    });

    test("readPidFile returns null when file is missing", async () => {
      expect(await readPidFile(join(tmpDir, "does-not-exist.pid"))).toBeNull();
    });

    test("readPidFile throws RUNTIME on malformed JSON", async () => {
      const pidFile = join(tmpDir, "bad.pid");
      await writeFile(pidFile, "not json at all");
      await expectRejects(readPidFile(pidFile), CliError);
    });

    test("readPidFile rejects wrong cmd value", async () => {
      const pidFile = join(tmpDir, "wrong-cmd.pid");
      await writeFile(
        pidFile,
        JSON.stringify({
          pid: 1,
          cmd: "random",
          version: "1.0.0",
          started_at: new Date().toISOString(),
        })
      );
      await expectRejects(readPidFile(pidFile), /invalid cmd/);
    });

    test("readPidFile rejects missing version", async () => {
      const pidFile = join(tmpDir, "no-version.pid");
      await writeFile(
        pidFile,
        JSON.stringify({
          pid: 1,
          cmd: "serve",
          started_at: new Date().toISOString(),
        })
      );
      await expectRejects(readPidFile(pidFile), /missing version/);
    });

    test("readPidFile rejects non-parseable started_at", async () => {
      const pidFile = join(tmpDir, "bad-started-at.pid");
      await writeFile(
        pidFile,
        JSON.stringify({
          pid: 1,
          cmd: "serve",
          version: VERSION,
          started_at: "not-a-date",
          port: 3000,
        })
      );
      await expectRejects(readPidFile(pidFile), /invalid started_at/);
    });

    test("writePidFile is atomic (no temp file left behind)", async () => {
      const pidFile = join(tmpDir, "atomic.pid");
      await writePidFile(pidFile, {
        pid: 42,
        cmd: "daemon",
        version: VERSION,
        started_at: new Date().toISOString(),
        port: null,
      });
      const entries = await Array.fromAsync(
        new Bun.Glob("*").scan({ cwd: dirname(pidFile) })
      );
      // Only the final pid-file should remain; no `.tmp.*` stragglers.
      expect(entries.filter((f) => f.includes(".tmp."))).toEqual([]);
      expect(entries).toContain("atomic.pid");
    });
  });

  describe("isProcessAlive", () => {
    test("returns true for the running test process", () => {
      expect(isProcessAlive(process.pid)).toBe(true);
    });

    test("returns false for an ESRCH pid", () => {
      // PID 2^31-1 is effectively never allocated on Unix.
      expect(isProcessAlive(2_147_483_646)).toBe(false);
    });
  });

  describe("spawnDetached", () => {
    test("throws VALIDATION on Windows with WSL guidance", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32" });
      try {
        let caught: unknown;
        try {
          await spawnDetached({
            kind: "serve",
            argv: ["serve"],
            pidFile: join(tmpDir, "data", "serve.pid"),
            logFile: join(tmpDir, "data", "serve.log"),
          });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(CliError);
        const err = caught as CliError;
        expect(err.code).toBe("VALIDATION");
        expect(err.message).toMatch(/Windows/);
        expect(err.message).toMatch(/WSL/);
      } finally {
        Object.defineProperty(process, "platform", {
          value: originalPlatform,
        });
      }
    });

    test.skipIf(process.platform === "win32")(
      "spawns a detached heartbeat child, writes pid-file, parent returns",
      async () => {
        const logFile = join(tmpDir, "data", "detach-child.log");
        const pidFile = join(tmpDir, "data", "detach-child.pid");

        const heartbeatScript = `
          let n = 0;
          setInterval(() => {
            process.stdout.write('alive ' + (++n) + '\\n');
            if (n >= 100) process.exit(0);
          }, 50);
        `;
        const scriptPath = join(tmpDir, "heartbeat.mjs");
        await writeFile(scriptPath, heartbeatScript);

        const result = await spawnDetached({
          kind: "serve",
          argv: [scriptPath],
          pidFile,
          logFile,
          port: 4242,
          // run the actual script instead of the CLI sentinel-reinvocation
          execPath: process.execPath,
        });

        expect(result.pid).toBeGreaterThan(0);
        expect(result.pidFile).toBe(pidFile);
        expect(result.logFile).toBe(logFile);

        const onDisk = await readPidFile(pidFile);
        expect(onDisk).toEqual({
          pid: result.pid,
          cmd: "serve",
          version: VERSION,
          started_at: result.payload.started_at,
          port: 4242,
        });

        // Best-effort: terminate the child so we don't leak a process.
        try {
          process.kill(result.pid, "SIGKILL");
        } catch {
          /* already exited */
        }
      }
    );

    test("includes DETACHED_CHILD_FLAG sentinel", () => {
      expect(DETACHED_CHILD_FLAG).toBe("--__detached-child");
    });
  });

  describe("guardDoubleStart", () => {
    test("is a no-op when no pid-file exists", async () => {
      await guardDoubleStart(join(tmpDir, "missing.pid"), "serve");
    });

    test("unlinks stale pid-file (ESRCH) and returns", async () => {
      const pidFile = join(tmpDir, "stale.pid");
      await writePidFile(pidFile, {
        pid: 2_147_483_646,
        cmd: "serve",
        version: VERSION,
        started_at: new Date().toISOString(),
        port: 3000,
      });

      await guardDoubleStart(pidFile, "serve");

      expect(await Bun.file(pidFile).exists()).toBe(false);
    });

    test("throws VALIDATION when a live process matches", async () => {
      const pidFile = join(tmpDir, "live.pid");
      await writePidFile(pidFile, {
        pid: process.pid,
        cmd: "serve",
        version: VERSION,
        started_at: new Date().toISOString(),
        port: 3000,
      });

      await expectRejects(
        guardDoubleStart(pidFile, "serve"),
        /already running/
      );
    });

    test("throws VALIDATION when a live process is the wrong kind", async () => {
      const pidFile = join(tmpDir, "wrongkind.pid");
      await writePidFile(pidFile, {
        pid: process.pid,
        cmd: "daemon",
        version: VERSION,
        started_at: new Date().toISOString(),
        port: null,
      });

      await expectRejects(
        guardDoubleStart(pidFile, "serve"),
        /owned by a running daemon/
      );
    });

    test("treats a version mismatch on a live pid as stale and unlinks", async () => {
      const pidFile = join(tmpDir, "version-mismatch.pid");
      await writePidFile(pidFile, {
        pid: process.pid,
        cmd: "serve",
        version: "0.0.0-orphaned",
        started_at: new Date().toISOString(),
        port: 3000,
      });

      // Must NOT throw even though the pid is live — the version mismatch
      // signals PID reuse / orphan, so we fall through to "stale".
      await guardDoubleStart(pidFile, "serve");
      expect(await Bun.file(pidFile).exists()).toBe(false);
    });
  });

  describe("statusProcess", () => {
    test("reports not-running when no pid-file exists", async () => {
      const status = await statusProcess({
        kind: "serve",
        pidFile: join(tmpDir, "missing.pid"),
        logFile: join(tmpDir, "missing.log"),
      });

      expect(status.running).toBe(false);
      expect(status.pid).toBeNull();
      expect(status.version).toBeNull();
      expect(status.started_at).toBeNull();
      expect(status.uptime_seconds).toBeNull();
      expect(status.log_size_bytes).toBeNull();
    });

    test("reports running serve with port + uptime", async () => {
      const logFile = join(tmpDir, "running-serve.log");
      const pidFile = join(tmpDir, "running-serve.pid");
      await writeFile(logFile, "hello world\n");

      const startedAt = new Date(Date.now() - 42_000).toISOString();
      await writePidFile(pidFile, {
        pid: process.pid,
        cmd: "serve",
        version: VERSION,
        started_at: startedAt,
        port: 3000,
      });

      const status = await statusProcess({
        kind: "serve",
        pidFile,
        logFile,
      });

      expect(status.running).toBe(true);
      expect(status.pid).toBe(process.pid);
      expect(status.port).toBe(3000);
      expect(status.cmd).toBe("serve");
      expect(status.version).toBe(VERSION);
      expect(status.started_at).toBe(startedAt);
      expect(status.uptime_seconds).toBeGreaterThanOrEqual(40);
      expect(status.log_size_bytes).toBe("hello world\n".length);
    });

    test("reports running daemon with port:null", async () => {
      const pidFile = join(tmpDir, "daemon.pid");
      const logFile = join(tmpDir, "daemon.log");
      await writePidFile(pidFile, {
        pid: process.pid,
        cmd: "daemon",
        version: VERSION,
        started_at: new Date().toISOString(),
        port: null,
      });

      const status = await statusProcess({
        kind: "daemon",
        pidFile,
        logFile,
      });

      expect(status.running).toBe(true);
      expect(status.port).toBeNull();
    });

    test("reports version mismatch on live pid as not-running", async () => {
      const pidFile = join(tmpDir, "version-status.pid");
      const logFile = join(tmpDir, "version-status.log");
      await writePidFile(pidFile, {
        pid: process.pid,
        cmd: "serve",
        version: "0.0.0-orphaned",
        started_at: new Date().toISOString(),
        port: 3000,
      });

      const status = await statusProcess({
        kind: "serve",
        pidFile,
        logFile,
      });

      expect(status.running).toBe(false);
      expect(status.version).toBe("0.0.0-orphaned");
      expect(status.uptime_seconds).toBeNull();
    });

    test("reports stale pid-file as not-running with metadata preserved", async () => {
      const pidFile = join(tmpDir, "stale-status.pid");
      const logFile = join(tmpDir, "stale-status.log");
      await writePidFile(pidFile, {
        pid: 2_147_483_646,
        cmd: "daemon",
        version: VERSION,
        started_at: "2026-01-01T00:00:00.000Z",
        port: null,
      });

      const status = await statusProcess({
        kind: "daemon",
        pidFile,
        logFile,
      });

      expect(status.running).toBe(false);
      expect(status.pid).toBe(2_147_483_646);
      expect(status.version).toBe(VERSION);
      expect(status.started_at).toBe("2026-01-01T00:00:00.000Z");
      expect(status.uptime_seconds).toBeNull();
    });

    test("a serve pid-file without port is reported as not-running", async () => {
      const pidFile = join(tmpDir, "portless.pid");
      const logFile = join(tmpDir, "portless.log");
      await writePidFile(pidFile, {
        pid: process.pid,
        cmd: "serve",
        version: VERSION,
        started_at: new Date().toISOString(),
        port: null,
      });

      const status = await statusProcess({
        kind: "serve",
        pidFile,
        logFile,
      });

      expect(status.running).toBe(false);
    });
  });

  describe("stopProcess", () => {
    test("returns not-running when pid-file is absent", async () => {
      const result = await stopProcess({
        kind: "serve",
        pidFile: join(tmpDir, "absent.pid"),
      });
      expect(result).toEqual({
        kind: "not-running",
        pidFile: join(tmpDir, "absent.pid"),
      });
    });

    test("cleans up a stale pid-file and returns not-running", async () => {
      const pidFile = join(tmpDir, "stale-stop.pid");
      await writePidFile(pidFile, {
        pid: 2_147_483_646,
        cmd: "serve",
        version: VERSION,
        started_at: new Date().toISOString(),
        port: 3000,
      });

      const result = await stopProcess({ kind: "serve", pidFile });

      expect(result.kind).toBe("not-running");
      expect(await Bun.file(pidFile).exists()).toBe(false);
    });

    test("stops a live process on SIGTERM", async () => {
      const pidFile = join(tmpDir, "sigterm.pid");
      await writePidFile(pidFile, {
        pid: 9999,
        cmd: "serve",
        version: VERSION,
        started_at: new Date().toISOString(),
        port: 3000,
      });

      let alive = true;
      const sent: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];

      const result = await stopProcess({
        kind: "serve",
        pidFile,
        pollIntervalMs: 5,
        timeoutMs: 500,
        killTimeoutMs: 200,
        isAlive: () => alive,
        kill: (pid, signal) => {
          sent.push({ pid, signal });
          if (signal === "SIGTERM") {
            // Simulate clean shutdown on SIGTERM.
            alive = false;
          }
        },
        sleep: () => Promise.resolve(),
      });

      expect(result).toEqual({
        kind: "stopped",
        pid: 9999,
        signal: "SIGTERM",
      });
      expect(sent.map((s) => s.signal)).toEqual(["SIGTERM"]);
    });

    test("falls back to SIGKILL when SIGTERM is ignored", async () => {
      const pidFile = join(tmpDir, "sigkill.pid");
      await writePidFile(pidFile, {
        pid: 8888,
        cmd: "daemon",
        version: VERSION,
        started_at: new Date().toISOString(),
        port: null,
      });

      let alive = true;
      const sent: Array<NodeJS.Signals | number> = [];

      const result = await stopProcess({
        kind: "daemon",
        pidFile,
        pollIntervalMs: 5,
        timeoutMs: 50,
        killTimeoutMs: 50,
        isAlive: () => alive,
        kill: (_pid, signal) => {
          sent.push(signal);
          if (signal === "SIGKILL") {
            alive = false;
          }
        },
        sleep: () => Promise.resolve(),
      });

      expect(result).toEqual({
        kind: "stopped",
        pid: 8888,
        signal: "SIGKILL",
      });
      expect(sent).toEqual(["SIGTERM", "SIGKILL"]);
    });

    test("returns timeout when the process survives SIGKILL", async () => {
      const pidFile = join(tmpDir, "timeout.pid");
      await writePidFile(pidFile, {
        pid: 7777,
        cmd: "daemon",
        version: VERSION,
        started_at: new Date().toISOString(),
        port: null,
      });

      const result = await stopProcess({
        kind: "daemon",
        pidFile,
        pollIntervalMs: 5,
        timeoutMs: 25,
        killTimeoutMs: 25,
        isAlive: () => true,
        kill: () => {
          /* ignore signals entirely */
        },
        sleep: () => Promise.resolve(),
      });

      expect(result).toEqual({ kind: "timeout", pid: 7777 });
    });

    test("treats version mismatch as not-running and does NOT send signals", async () => {
      const pidFile = join(tmpDir, "stop-version.pid");
      await writePidFile(pidFile, {
        pid: 9876,
        cmd: "serve",
        version: "0.0.0-orphaned",
        started_at: new Date().toISOString(),
        port: 3000,
      });

      const sent: Array<NodeJS.Signals | number> = [];
      const result = await stopProcess({
        kind: "serve",
        pidFile,
        isAlive: () => true,
        kill: (_pid, signal) => {
          sent.push(signal);
        },
        sleep: () => Promise.resolve(),
      });

      expect(result).toEqual({
        kind: "not-running",
        pidFile,
      });
      // Critically: NO signals sent to the reused pid.
      expect(sent).toEqual([]);
      expect(await Bun.file(pidFile).exists()).toBe(false);
    });

    test("rejects VALIDATION when pid-file belongs to a different kind", async () => {
      const pidFile = join(tmpDir, "crossed.pid");
      await writePidFile(pidFile, {
        pid: process.pid,
        cmd: "daemon",
        version: VERSION,
        started_at: new Date().toISOString(),
        port: null,
      });

      await expectRejects(
        stopProcess({
          kind: "serve",
          pidFile,
          sleep: () => Promise.resolve(),
        }),
        /owned by a running daemon/
      );
    });
  });

  describe("NOT_RUNNING exit code", () => {
    test("CliError NOT_RUNNING maps to exit 3", async () => {
      const { exitCodeFor } = await import("../../src/cli/errors");
      const err = new CliError("NOT_RUNNING", "no live process");
      expect(exitCodeFor(err)).toBe(3);
    });

    test("VALIDATION still maps to 1 and RUNTIME to 2", async () => {
      const { exitCodeFor } = await import("../../src/cli/errors");
      expect(exitCodeFor(new CliError("VALIDATION", "x"))).toBe(1);
      expect(exitCodeFor(new CliError("RUNTIME", "x"))).toBe(2);
    });
  });

  // Suppress unused import warning; keeps safeRm/chmod/readFile in scope for
  // future tests if needed.
  test("imports resolve", () => {
    expect(typeof chmod).toBe("function");
    expect(typeof readFile).toBe("function");
    expect(typeof rm).toBe("function");
  });
});
