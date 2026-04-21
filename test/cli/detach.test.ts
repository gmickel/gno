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
  inspectForeignLive,
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
          // Self-contained script: skip the default `process.argv[1]`
          // prepend by opting the entry script out.
          entryScript: null,
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

    test.skipIf(process.platform === "win32")(
      "default re-exec includes the CLI entry script before user argv",
      async () => {
        // Echo the full argv and exit immediately so the child's first line
        // in the log file captures what cmdPrefix was used.
        const logFile = join(tmpDir, "data", "argv-echo.log");
        const pidFile = join(tmpDir, "data", "argv-echo.pid");

        const echoScript = `
          process.stdout.write(JSON.stringify(process.argv) + '\\n');
          process.exit(0);
        `;
        const echoPath = join(tmpDir, "echo-argv.mjs");
        await writeFile(echoPath, echoScript);

        // Simulate a real CLI entry: cmdPrefix = [bun, src/index.ts].
        // We use our echo script as the "entry" so the child actually runs.
        const result = await spawnDetached({
          kind: "serve",
          argv: ["serve", "--port", "3000"],
          pidFile,
          logFile,
          port: 3000,
          cmdPrefix: [process.execPath, echoPath],
        });

        expect(result.pid).toBeGreaterThan(0);

        // Give the child a moment to flush + exit.
        await new Promise((r) => setTimeout(r, 400));
        const logged = await readFile(logFile, "utf8");
        const argv = JSON.parse(logged.trim()) as string[];
        // argv[0] = bun, argv[1] = echoPath (our stand-in entry script),
        // then the user argv, then the sentinel. Critically argv[1] must
        // be present — that's what the bug was.
        expect(argv[0]).toContain("bun");
        // Bun may resolve the script path through /private/var symlinks on
        // macOS; compare by basename to stay portable.
        expect(argv[1]?.endsWith("echo-argv.mjs")).toBe(true);
        expect(argv.slice(2)).toEqual([
          "serve",
          "--port",
          "3000",
          DETACHED_CHILD_FLAG,
        ]);
      }
    );

    test("includes DETACHED_CHILD_FLAG sentinel", () => {
      expect(DETACHED_CHILD_FLAG).toBe("--__detached-child");
    });

    test.skipIf(process.platform === "win32")(
      "kills the spawned child and throws RUNTIME when pid-file write fails",
      async () => {
        // Force writePidFile to fail by making the pid-file path itself a
        // directory — atomicWrite's rename(tmpFile, pidFile) will fail with
        // EISDIR. The parent-dir mkdir in spawnDetached succeeds normally.
        const pidFile = join(tmpDir, "data", "pid-is-a-dir.pid");
        await mkdir(pidFile, { recursive: true });

        const heartbeatScript = `
          setInterval(() => {
            process.stdout.write('alive\\n');
          }, 200);
        `;
        const scriptPath = join(tmpDir, "write-fail-child.mjs");
        await writeFile(scriptPath, heartbeatScript);

        let caught: unknown;
        let childPid: number | undefined;
        try {
          await spawnDetached({
            kind: "serve",
            argv: [scriptPath],
            pidFile,
            logFile: join(tmpDir, "data", "write-fail.log"),
            port: 4243,
            entryScript: null,
          });
        } catch (error) {
          caught = error;
          const msg = error instanceof Error ? error.message : "";
          const match = msg.match(/pid (\d+)\)/);
          if (match) {
            childPid = Number(match[1]);
          }
        }

        expect(caught).toBeInstanceOf(CliError);
        const err = caught as CliError;
        expect(err.code).toBe("RUNTIME");
        expect(err.message).toMatch(/failed to write pid-file/);
        expect(err.message).toMatch(/child was signaled/);

        // Give the SIGTERM/SIGKILL fire-and-forget a moment to land, then
        // confirm the orphan is gone.
        await new Promise((r) => setTimeout(r, 1500));
        if (childPid !== undefined) {
          expect(isProcessAlive(childPid)).toBe(false);
        }
      }
    );
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

    test("blocks with VALIDATION when a live pid records a different gno version", async () => {
      const pidFile = join(tmpDir, "version-mismatch.pid");
      await writePidFile(pidFile, {
        pid: process.pid,
        cmd: "serve",
        version: "0.0.0-orphaned",
        started_at: new Date().toISOString(),
        port: 3000,
      });

      // Live-foreign: must block the double-start rather than silently
      // unlinking and allowing a second serve to race the orphan.
      await expectRejects(
        guardDoubleStart(pidFile, "serve"),
        /pid-file.*records a running serve/
      );
      // Critically: pid-file stays in place so the operator still sees it.
      expect(await Bun.file(pidFile).exists()).toBe(true);
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

    test("reports version mismatch on live pid as not-running in the schema payload", async () => {
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

  describe("inspectForeignLive", () => {
    test("returns null when no pid-file exists", async () => {
      expect(
        await inspectForeignLive({
          kind: "serve",
          pidFile: join(tmpDir, "missing.pid"),
        })
      ).toBeNull();
    });

    test("returns null when versions match on a live pid", async () => {
      const pidFile = join(tmpDir, "match.pid");
      await writePidFile(pidFile, {
        pid: process.pid,
        cmd: "serve",
        version: VERSION,
        started_at: new Date().toISOString(),
        port: 3000,
      });
      expect(await inspectForeignLive({ kind: "serve", pidFile })).toBeNull();
    });

    test("returns null when pid is dead", async () => {
      const pidFile = join(tmpDir, "dead-pid.pid");
      await writePidFile(pidFile, {
        pid: 2_147_483_646,
        cmd: "serve",
        version: "0.0.0-orphaned",
        started_at: new Date().toISOString(),
        port: 3000,
      });
      expect(await inspectForeignLive({ kind: "serve", pidFile })).toBeNull();
    });

    test("returns null when cmds disagree", async () => {
      const pidFile = join(tmpDir, "wrong-kind.pid");
      await writePidFile(pidFile, {
        pid: process.pid,
        cmd: "daemon",
        version: "0.0.0-orphaned",
        started_at: new Date().toISOString(),
        port: null,
      });
      expect(await inspectForeignLive({ kind: "serve", pidFile })).toBeNull();
    });

    test("surfaces signal on live + matching cmd + mismatched version", async () => {
      const pidFile = join(tmpDir, "foreign.pid");
      await writePidFile(pidFile, {
        pid: process.pid,
        cmd: "serve",
        version: "0.0.0-orphaned",
        started_at: new Date().toISOString(),
        port: 3000,
      });
      expect(await inspectForeignLive({ kind: "serve", pidFile })).toEqual({
        pid: process.pid,
        recordedVersion: "0.0.0-orphaned",
        currentVersion: VERSION,
      });
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

    test("returns foreign-live on version mismatch and does NOT signal/unlink", async () => {
      const pidFile = join(tmpDir, "stop-version.pid");
      const payload = {
        pid: 9876,
        cmd: "serve" as const,
        version: "0.0.0-orphaned",
        started_at: new Date().toISOString(),
        port: 3000,
      };
      await writePidFile(pidFile, payload);

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
        kind: "foreign-live",
        pid: 9876,
        payload,
      });
      // Critically: NO signals sent to the pid we can't verify.
      expect(sent).toEqual([]);
      // Pid-file stays in place so the operator still sees the orphan.
      expect(await Bun.file(pidFile).exists()).toBe(true);
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
