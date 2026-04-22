/**
 * End-to-end integration tests for `gno serve` / `gno daemon` self-backgrounding.
 * (fn-72.5)
 *
 * Unlike the wiring suites in `test/cli/serve-flags.test.ts` and
 * `test/cli/daemon-flags.test.ts`, this file actually spawns detached
 * child processes via `Bun.spawn(["bun", "src/index.ts", ...])` and
 * exercises the full pid-file → liveness → SIGTERM lifecycle. Each test
 * gets its own `mkdtemp` data dir via `GNO_DATA_DIR` so the real user
 * data dir is never touched and parallel test files don't collide.
 *
 * Test cases follow the numbering in
 * `.flow/tasks/fn-72-backgrounding-flags-for-serve-and-daemon.5.md`. A few
 * pure-CLI cases (6, 7, 9, 10) are runnable on Windows; the rest skip.
 *
 * IMPORTANT: every test must terminate any child it spawned (best-effort
 * `kill -9` in the cleanup branch) so a failed assertion never leaks a
 * detached process onto the developer machine.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeSync, openSync, utimesSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { VERSION } from "../../src/app/constants";
import { DETACHED_CHILD_FLAG } from "../../src/cli/detach";
import { safeRm } from "../helpers/cleanup";

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const IS_WIN = process.platform === "win32";
// Repo convention from test/cli/concurrency.test.ts: 20s budget on Windows
// (slower process spawn), 15s elsewhere (still well under the per-suite 30s
// epic budget).
const TEST_TIMEOUT_MS = IS_WIN ? 20_000 : 15_000;
// SIGKILL fallback test pays a real SIGTERM-grace cost; give it more room.
const SIGKILL_TEST_TIMEOUT_MS = IS_WIN ? 30_000 : 25_000;

let _seq = 0;

function uniqueDirName(prefix: string): string {
  _seq += 1;
  return `${prefix}-${process.pid}-${Date.now()}-${_seq}`;
}

async function makeTestDir(prefix = "gno-detach-int"): Promise<string> {
  const base = join(tmpdir(), uniqueDirName(prefix));
  await mkdir(base, { recursive: true });
  return base;
}

interface CliEnv {
  GNO_CONFIG_DIR: string;
  GNO_DATA_DIR: string;
  GNO_CACHE_DIR: string;
  [key: string]: string | undefined;
}

function envForTestDir(testDir: string): CliEnv {
  return {
    ...process.env,
    GNO_CONFIG_DIR: join(testDir, "config"),
    GNO_DATA_DIR: join(testDir, "data"),
    GNO_CACHE_DIR: join(testDir, "cache"),
    // Critical: serve's createServerContext otherwise tries to download a
    // ~640MB LLM model on first boot, which both takes minutes and requires
    // network. Offline mode skips that path entirely so the integration
    // suite stays fast and hermetic.
    GNO_OFFLINE: "1",
    // Force a TTY-less, deterministic environment.
    NO_COLOR: "1",
    CI: "1",
  };
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `bun src/index.ts ...` synchronously to completion and capture its
 * streams. This is the right pattern for management commands (`--status`,
 * `--stop`, validation errors) that exit fast.
 */
async function runCli(
  args: string[],
  env: CliEnv,
  options: { timeoutMs?: number } = {}
): Promise<CliResult> {
  const timeoutMs = options.timeoutMs ?? TEST_TIMEOUT_MS;
  const child = Bun.spawn({
    cmd: ["bun", "src/index.ts", ...args],
    cwd: PROJECT_ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
  }, timeoutMs);
  // Don't keep the test runner alive on this timer — we always clear it
  // below in the `finally`-equivalent path.
  timeout.unref?.();

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code: exitCode, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Best-effort kill — used in afterEach to make sure no detached child
 * survives a failed assertion. SIGKILL because we don't care about clean
 * shutdown here; we just don't want process leaks polluting the dev box.
 */
function bestEffortKill(pid: number | undefined): void {
  if (pid === undefined || pid <= 0) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T = unknown>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as T;
}

async function waitFor<T>(
  fn: () => Promise<T | null | undefined> | T | null | undefined,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  let last: T | null | undefined;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) {
      return last;
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(
    `waitFor${options.label ? ` (${options.label})` : ""} timed out after ${timeoutMs}ms; last=${String(last)}`
  );
}

/**
 * Wait for a serve to actually answer HTTP. We hit /api/health which is the
 * cheapest endpoint Bun.serve exposes (no SQLite, no LLM init).
 */
async function waitForHttpReady(
  port: number,
  options: { timeoutMs?: number } = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  await waitFor(
    async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.ok) {
          // Drain so the connection is closed cleanly even if Bun's keep-alive
          // pool would otherwise dangle it.
          await res.text();
          return true;
        }
        return null;
      } catch {
        return null;
      }
    },
    { timeoutMs, intervalMs: 100, label: `serve listening on ${port}` }
  );
}

/**
 * Wait until `pid` reports as not-alive. We poll because SIGTERM/SIGKILL are
 * async w.r.t. the kernel reaping the process.
 */
async function waitForExit(pid: number, timeoutMs = 5_000): Promise<void> {
  await waitFor(() => (!isAlive(pid) ? true : null), {
    timeoutMs,
    intervalMs: 50,
    label: `pid ${pid} exit`,
  });
}

/**
 * Pick a port that is unlikely to collide with anything else. We use a
 * simple ephemeral-range PRNG seeded by the test sequence + pid so multiple
 * concurrent test files don't clash.
 */
function pickPort(): number {
  // 20000-39999 — well above the privileged range, well below the typical
  // ephemeral range (49152+) most kernels hand out by default.
  const span = 20_000;
  return 20_000 + Math.floor(Math.random() * span);
}

/**
 * Read the live argv for a process. macOS uses `ps -o args=`; Linux exposes
 * `/proc/<pid>/cmdline`. Returns null on Windows or if the lookup fails.
 */
async function readLiveArgv(pid: number): Promise<string[] | null> {
  if (IS_WIN) {
    return null;
  }
  if (process.platform === "linux") {
    try {
      const raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
      // /proc cmdline is NUL-separated; trailing NUL is normal.
      return raw.split("\0").filter((s) => s.length > 0);
    } catch {
      return null;
    }
  }
  // macOS (and other BSDs) — fall back to `ps`. We use `=` to suppress the
  // header so the output is just the argv string. Quoting is not faithful
  // (ps collapses quoted args), but we only check for substring presence.
  try {
    const proc = Bun.spawn({
      cmd: ["ps", "-o", "args=", "-p", String(pid)],
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const trimmed = out.trim();
    if (trimmed.length === 0) {
      return null;
    }
    return trimmed.split(/\s+/);
  } catch {
    return null;
  }
}

interface CollectionInit {
  /** Path under testDir that gets seeded with a one-file collection. */
  notesDir: string;
}

/**
 * Many of the integration cases need a working gno install: a config dir, a
 * data dir, and at least one collection so daemon's `requireCollections`
 * check passes. We spin one up via the real CLI once per test.
 */
async function initSampleCollection(
  testDir: string,
  env: CliEnv
): Promise<CollectionInit> {
  const notesDir = join(testDir, "notes");
  await mkdir(notesDir, { recursive: true });
  await writeFile(
    join(notesDir, "hello.md"),
    "# Hello\n\nA tiny doc so the collection isn't empty.\n"
  );

  const init = await runCli(["init", notesDir, "--name", "notes"], env);
  if (init.code !== 0) {
    throw new Error(
      `init failed (code ${init.code}): stdout=${init.stdout} stderr=${init.stderr}`
    );
  }
  return { notesDir };
}

interface DetachedSpawn {
  pid: number;
  pidFile: string;
  logFile: string;
  /**
   * Listening port for serve detaches; null for daemon detaches (daemon is
   * headless and never binds a port). Helpers that pass `port` through
   * `--port` always populate it.
   */
  port: number | null;
}

/**
 * Spawn `gno serve --detach` and wait for the pid-file to appear. Returns
 * the pid the parent reported plus the resolved paths so the test can
 * assert on them.
 */
async function spawnServeDetached(
  testDir: string,
  env: CliEnv,
  options: { port?: number; extraArgs?: string[] } = {}
): Promise<DetachedSpawn> {
  const port = options.port ?? pickPort();
  const pidFile = join(testDir, "data", "serve.pid");
  const logFile = join(testDir, "data", "serve.log");
  const result = await runCli(
    [
      "serve",
      "--detach",
      "--port",
      String(port),
      "--pid-file",
      pidFile,
      "--log-file",
      logFile,
      ...(options.extraArgs ?? []),
    ],
    env
  );
  if (result.code !== 0) {
    throw new Error(
      `serve --detach failed (code ${result.code}): stdout=${result.stdout} stderr=${result.stderr}`
    );
  }

  // Pid-file should appear effectively immediately — the parent only returns
  // after writePidFile, but the file is written via atomicWrite (rename), so
  // give it a tiny buffer in case the OS is slow.
  const payload = await waitFor(
    async () => {
      if (!(await pathExists(pidFile))) {
        return null;
      }
      try {
        return await readJsonFile<{ pid: number; port: number }>(pidFile);
      } catch {
        return null;
      }
    },
    { timeoutMs: 5_000, label: "serve pid-file" }
  );

  return { pid: payload.pid, pidFile, logFile, port };
}

/**
 * Narrow `DetachedSpawn.port` to `number` for serve cases. The serve helper
 * always sets `port`; daemon helpers leave it `null`. Throws if the contract
 * is violated rather than silently coercing.
 */
function requirePort(spawned: DetachedSpawn): number {
  if (spawned.port === null) {
    throw new Error("expected serve spawn to carry a port");
  }
  return spawned.port;
}

async function spawnDaemonDetached(
  testDir: string,
  env: CliEnv
): Promise<DetachedSpawn> {
  const pidFile = join(testDir, "data", "daemon.pid");
  const logFile = join(testDir, "data", "daemon.log");
  const result = await runCli(
    [
      "daemon",
      "--detach",
      "--no-sync-on-start",
      "--pid-file",
      pidFile,
      "--log-file",
      logFile,
    ],
    env
  );
  if (result.code !== 0) {
    throw new Error(
      `daemon --detach failed (code ${result.code}): stdout=${result.stdout} stderr=${result.stderr}`
    );
  }

  const payload = await waitFor(
    async () => {
      if (!(await pathExists(pidFile))) {
        return null;
      }
      try {
        return await readJsonFile<{ pid: number }>(pidFile);
      } catch {
        return null;
      }
    },
    { timeoutMs: 5_000, label: "daemon pid-file" }
  );

  return { pid: payload.pid, pidFile, logFile, port: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite — Unix lifecycle (cases 1–15)
// ─────────────────────────────────────────────────────────────────────────────

describe("detach integration (Unix)", () => {
  let testDir: string;
  let env: CliEnv;
  /** Pids spawned during this test that must not survive afterEach. */
  const spawnedPids = new Set<number>();

  beforeEach(async () => {
    testDir = await makeTestDir();
    env = envForTestDir(testDir);
    spawnedPids.clear();
  });

  afterEach(async () => {
    // Kill any lingering children before the data dir is wiped, otherwise a
    // detached gno serve might keep an open SQLite handle on the soon-to-be
    // deleted file.
    for (const pid of spawnedPids) {
      bestEffortKill(pid);
    }
    // Bounded wait so the OS has time to reap before we rm the dir.
    for (const pid of spawnedPids) {
      try {
        await waitForExit(pid, 2_000);
      } catch {
        // Best effort; safeRm has retry for the SQLite-lock case.
      }
    }
    spawnedPids.clear();

    // Belt-and-braces: clean up any .startlock sidecar files left behind.
    // spawnDetached releases on success and failure paths, but a hard test
    // crash mid-spawn could leak one.
    const dataDir = join(testDir, "data");
    if (await pathExists(dataDir)) {
      try {
        for await (const name of new Bun.Glob("*.startlock").scan({
          cwd: dataDir,
          absolute: false,
        })) {
          try {
            await Bun.file(join(dataDir, name)).delete();
          } catch {
            // already gone
          }
        }
      } catch {
        // glob can fail if dataDir disappeared mid-iteration — fine.
      }
    }

    await safeRm(testDir);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Case 1: serve --detach full lifecycle
  // ───────────────────────────────────────────────────────────────────────────
  test.skipIf(IS_WIN)(
    "case 1: serve --detach → pid-file → HTTP 200 → status running → stop → cleanup",
    async () => {
      await initSampleCollection(testDir, env);

      const spawned = await spawnServeDetached(testDir, env);
      spawnedPids.add(spawned.pid);

      // Pid-file exists and matches.
      expect(await pathExists(spawned.pidFile)).toBe(true);
      const pidPayload = await readJsonFile<{
        pid: number;
        cmd: string;
        port: number;
        version: string;
      }>(spawned.pidFile);
      expect(pidPayload.pid).toBe(spawned.pid);
      expect(pidPayload.cmd).toBe("serve");
      expect(pidPayload.port).toBe(requirePort(spawned));
      expect(pidPayload.version).toBe(VERSION);

      // HTTP responds.
      await waitForHttpReady(requirePort(spawned));

      // --status reports running.
      const status = await runCli(
        [
          "serve",
          "--status",
          "--json",
          "--pid-file",
          spawned.pidFile,
          "--log-file",
          spawned.logFile,
        ],
        env
      );
      expect(status.code).toBe(0);
      const statusPayload = JSON.parse(status.stdout) as Record<
        string,
        unknown
      >;
      expect(statusPayload.running).toBe(true);
      expect(statusPayload.pid).toBe(spawned.pid);
      expect(statusPayload.port).toBe(requirePort(spawned));

      // --stop kills cleanly and removes the pid-file.
      const stop = await runCli(
        [
          "serve",
          "--stop",
          "--pid-file",
          spawned.pidFile,
          "--log-file",
          spawned.logFile,
        ],
        env,
        { timeoutMs: 20_000 }
      );
      expect(stop.code).toBe(0);
      expect(stop.stdout).toMatch(/Stopped gno serve/);

      await waitForExit(spawned.pid, 5_000);
      // installPidFileCleanup unlinks on the SIGTERM path, so the file must
      // be gone after the child exits.
      await waitFor(
        async () => ((await pathExists(spawned.pidFile)) ? null : true),
        { timeoutMs: 3_000, label: "pid-file removed after --stop" }
      );
    },
    SIGKILL_TEST_TIMEOUT_MS
  );

  // ───────────────────────────────────────────────────────────────────────────
  // Case 2: daemon --detach full lifecycle
  // ───────────────────────────────────────────────────────────────────────────
  test.skipIf(IS_WIN)(
    "case 2: daemon --detach → pid-file → status running → stop",
    async () => {
      await initSampleCollection(testDir, env);

      const spawned = await spawnDaemonDetached(testDir, env);
      spawnedPids.add(spawned.pid);

      expect(await pathExists(spawned.pidFile)).toBe(true);

      const status = await runCli(
        [
          "daemon",
          "--status",
          "--json",
          "--pid-file",
          spawned.pidFile,
          "--log-file",
          spawned.logFile,
        ],
        env
      );
      expect(status.code).toBe(0);
      const statusPayload = JSON.parse(status.stdout) as Record<
        string,
        unknown
      >;
      expect(statusPayload.running).toBe(true);
      expect(statusPayload.pid).toBe(spawned.pid);
      // Daemon is headless — port is always null in the schema.
      expect(statusPayload.port).toBeNull();

      const stop = await runCli(
        [
          "daemon",
          "--stop",
          "--pid-file",
          spawned.pidFile,
          "--log-file",
          spawned.logFile,
        ],
        env,
        { timeoutMs: 20_000 }
      );
      expect(stop.code).toBe(0);
      expect(stop.stdout).toMatch(/Stopped gno daemon/);

      await waitForExit(spawned.pid, 5_000);
    },
    SIGKILL_TEST_TIMEOUT_MS
  );

  // ───────────────────────────────────────────────────────────────────────────
  // Case 3: double-start guard
  // ───────────────────────────────────────────────────────────────────────────
  test.skipIf(IS_WIN)(
    "case 3: serve --detach twice → second exits 1 (already running OR start-lock race)",
    async () => {
      await initSampleCollection(testDir, env);

      const first = await spawnServeDetached(testDir, env);
      spawnedPids.add(first.pid);
      const firstPort = requirePort(first);
      await waitForHttpReady(firstPort);

      // Second invocation against the same data dir / pid-file.
      const second = await runCli(
        [
          "serve",
          "--detach",
          "--port",
          String(firstPort),
          "--pid-file",
          first.pidFile,
          "--log-file",
          first.logFile,
        ],
        env
      );
      expect(second.code).toBe(1);
      // Per task spec: either the guardDoubleStart path ("already running")
      // or the start-lock race ("another serve start is in progress") is
      // acceptable. Both are VALIDATION errors with operator-readable text.
      expect(second.stderr).toMatch(
        /already running|another serve start is in progress/
      );
    },
    SIGKILL_TEST_TIMEOUT_MS
  );

  // ───────────────────────────────────────────────────────────────────────────
  // Case 4: stale pid-file
  // ───────────────────────────────────────────────────────────────────────────
  test.skipIf(IS_WIN)(
    "case 4: stale pid-file → status NOT_RUNNING → detach succeeds and overwrites",
    async () => {
      await initSampleCollection(testDir, env);

      const pidFile = join(testDir, "data", "serve.pid");
      const logFile = join(testDir, "data", "serve.log");
      await mkdir(dirname(pidFile), { recursive: true });

      // Schema-valid, but pid is dead. 2^22 - 1 is well past the default
      // Linux pid_max and macOS pid space.
      const stale = {
        pid: 4_194_303,
        cmd: "serve",
        version: VERSION,
        started_at: new Date().toISOString(),
        port: pickPort(),
      };
      await writeFile(pidFile, `${JSON.stringify(stale)}\n`);

      const status = await runCli(
        ["serve", "--status", "--pid-file", pidFile, "--log-file", logFile],
        env
      );
      expect(status.code).toBe(3);
      expect(status.stdout).toContain("running  no");

      // Now actually detach — guardDoubleStart must unlink the stale file.
      const port = pickPort();
      const real = await runCli(
        [
          "serve",
          "--detach",
          "--port",
          String(port),
          "--pid-file",
          pidFile,
          "--log-file",
          logFile,
        ],
        env
      );
      expect(real.code).toBe(0);
      const liveFile = await readJsonFile<{ pid: number; port: number }>(
        pidFile
      );
      expect(liveFile.pid).not.toBe(stale.pid);
      expect(liveFile.port).toBe(port);
      spawnedPids.add(liveFile.pid);
    },
    SIGKILL_TEST_TIMEOUT_MS
  );

  // ───────────────────────────────────────────────────────────────────────────
  // Case 5: SIGKILL fallback (intentionally slow)
  // ───────────────────────────────────────────────────────────────────────────
  test.skipIf(IS_WIN)(
    "case 5: SIGTERM-ignoring child → --stop escalates to SIGKILL",
    async () => {
      // We don't need a real serve here — we just need a process the stop
      // helper will signal. Spawn a small Bun script that ignores SIGTERM
      // and write a pid-file pointing at it. Then run `serve --stop` against
      // that pid-file and assert the child is gone.
      const pidFile = join(testDir, "data", "serve.pid");
      const logFile = join(testDir, "data", "serve.log");
      await mkdir(dirname(pidFile), { recursive: true });

      const stubbornScript = join(testDir, "stubborn.mjs");
      await writeFile(
        stubbornScript,
        `process.on("SIGTERM", () => { /* swallow */ });
         setInterval(() => {}, 1000);`
      );

      const child = Bun.spawn({
        cmd: [process.execPath, stubbornScript],
        stdout: "ignore",
        stderr: "ignore",
        // Detach so killing the test runner doesn't take the child with it
        // accidentally; we kill it explicitly via --stop.
        detached: true,
      });
      child.unref();
      spawnedPids.add(child.pid);

      const payload = {
        pid: child.pid,
        cmd: "serve",
        version: VERSION,
        started_at: new Date().toISOString(),
        port: pickPort(),
      };
      await writeFile(pidFile, `${JSON.stringify(payload)}\n`);

      // Stop — SIGTERM is ignored, so the helper must escalate to SIGKILL.
      // Default budget is 10s SIGTERM grace + 2s SIGKILL grace; runCli's
      // 25s timeout covers it comfortably.
      const stop = await runCli(
        ["serve", "--stop", "--pid-file", pidFile, "--log-file", logFile],
        env,
        { timeoutMs: SIGKILL_TEST_TIMEOUT_MS }
      );
      expect(stop.code).toBe(0);
      expect(stop.stdout).toMatch(/SIGKILL/);

      await waitForExit(child.pid, 5_000);
    },
    // Real wall-clock cost: SIGTERM grace (~10s default) + reaping + spawn
    // overhead. Bump well past TEST_TIMEOUT_MS.
    SIGKILL_TEST_TIMEOUT_MS + 15_000
  );

  // ───────────────────────────────────────────────────────────────────────────
  // Case 6: --stop with no pid-file — silent NOT_RUNNING
  // ───────────────────────────────────────────────────────────────────────────
  // Pure CLI parsing path; runs on Windows too (pinned to Unix block by the
  // sentinel-strip case below — case 11 — being a real subprocess; case 6 is
  // also covered separately for daemon below). Keep it here so the "Unix
  // suite" runs the full numbered list end-to-end.
  test(
    "case 6 (serve): --stop with no pid-file exits 3 silently (stderr empty)",
    async () => {
      const pidFile = join(testDir, "data", "serve.pid");
      const logFile = join(testDir, "data", "serve.log");
      const stop = await runCli(
        ["serve", "--stop", "--pid-file", pidFile, "--log-file", logFile],
        env
      );
      expect(stop.code).toBe(3);
      expect(stop.stdout).toBe("");
      // Critical: the silent CliError path must produce *no* stderr output
      // at all — not a JSON envelope, not a plain "Error:" line.
      expect(stop.stderr).toBe("");
    },
    TEST_TIMEOUT_MS
  );

  test(
    "case 6 (daemon): --stop with no pid-file exits 3 silently (stderr empty)",
    async () => {
      const pidFile = join(testDir, "data", "daemon.pid");
      const logFile = join(testDir, "data", "daemon.log");
      const stop = await runCli(
        ["daemon", "--stop", "--pid-file", pidFile, "--log-file", logFile],
        env
      );
      expect(stop.code).toBe(3);
      expect(stop.stdout).toBe("");
      expect(stop.stderr).toBe("");
    },
    TEST_TIMEOUT_MS
  );

  // ───────────────────────────────────────────────────────────────────────────
  // Case 7: --json gating
  // ───────────────────────────────────────────────────────────────────────────
  test(
    "case 7: --json outside --status is rejected (VALIDATION) on serve and daemon",
    async () => {
      const pidFile = join(testDir, "data", "x.pid");
      const logFile = join(testDir, "data", "x.log");

      // Subcommand-local --json with --detach.
      const a = await runCli(
        [
          "serve",
          "--detach",
          "--json",
          "--pid-file",
          pidFile,
          "--log-file",
          logFile,
        ],
        env
      );
      expect(a.code).toBe(1);
      expect(a.stderr).toMatch(/--json/);
      expect(a.stderr).toMatch(/--status/);

      // Subcommand-local --json with --stop.
      const b = await runCli(
        [
          "serve",
          "--stop",
          "--json",
          "--pid-file",
          pidFile,
          "--log-file",
          logFile,
        ],
        env
      );
      expect(b.code).toBe(1);
      expect(b.stderr).toMatch(/--json/);

      // Daemon equivalent.
      const c = await runCli(
        [
          "daemon",
          "--detach",
          "--json",
          "--pid-file",
          pidFile,
          "--log-file",
          logFile,
        ],
        env
      );
      expect(c.code).toBe(1);
      expect(c.stderr).toMatch(/--json/);
      expect(c.stderr).toMatch(/--status/);

      // Global --json before the subcommand should also trip the same
      // gate — Commander hoists the flag.
      const d = await runCli(
        [
          "--json",
          "serve",
          "--detach",
          "--pid-file",
          pidFile,
          "--log-file",
          logFile,
        ],
        env
      );
      expect(d.code).toBe(1);
      expect(d.stderr).toMatch(/--json/);
    },
    TEST_TIMEOUT_MS
  );

  // ───────────────────────────────────────────────────────────────────────────
  // Case 8: foreign-live --status --json envelope shape
  // ───────────────────────────────────────────────────────────────────────────
  // Skipped on Windows: the foreign-live half of the case spawns a detached
  // child process (`Bun.spawn({ detached: true, ... })`) to hold a stable
  // pid alive while we probe it. That mechanic is exactly what this epic
  // declines to support on Windows; running it on win32 would flake or
  // hang outside the case-16 coverage. The pure-CLI half (no foreign
  // signal) is already exercised by case 9 below, which IS Windows-safe.
  test.skipIf(IS_WIN)(
    "case 8: --status --json carries foreign_live details when applicable; absent otherwise",
    async () => {
      const pidFile = join(testDir, "data", "serve.pid");
      const logFile = join(testDir, "data", "serve.log");
      await mkdir(dirname(pidFile), { recursive: true });

      // First: NO foreign-live (clean stale path) → details should be absent
      // entirely from the NOT_RUNNING envelope.
      const stale = {
        pid: 4_194_303,
        cmd: "serve",
        version: VERSION,
        started_at: new Date().toISOString(),
        port: 4242,
      };
      await writeFile(pidFile, `${JSON.stringify(stale)}\n`);

      const noForeign = await runCli(
        [
          "serve",
          "--status",
          "--json",
          "--pid-file",
          pidFile,
          "--log-file",
          logFile,
        ],
        env
      );
      expect(noForeign.code).toBe(3);
      const envelopeNoForeign = JSON.parse(noForeign.stderr.trim()) as {
        error: { code: string; details?: unknown };
      };
      expect(envelopeNoForeign.error.code).toBe("NOT_RUNNING");
      expect(envelopeNoForeign.error.details).toBeUndefined();

      // Now: WITH foreign-live (live pid + version mismatch). The runCli
      // child is short-lived so its pid is reaped quickly; we use a long-
      // running stubborn child so the pid is reliably alive when --status
      // probes it.
      const stubbornScript = join(testDir, "stubborn-foreign.mjs");
      await writeFile(stubbornScript, `setInterval(() => {}, 1000);`);
      const stubborn = Bun.spawn({
        cmd: [process.execPath, stubbornScript],
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
      });
      stubborn.unref();
      spawnedPids.add(stubborn.pid);

      const foreignPayload = {
        pid: stubborn.pid,
        cmd: "serve",
        version: "0.0.0-foreign-test",
        started_at: new Date().toISOString(),
        port: 4242,
      };
      await writeFile(pidFile, `${JSON.stringify(foreignPayload)}\n`);

      const withForeign = await runCli(
        [
          "serve",
          "--status",
          "--json",
          "--pid-file",
          pidFile,
          "--log-file",
          logFile,
        ],
        env
      );
      expect(withForeign.code).toBe(3);
      const envelope = JSON.parse(withForeign.stderr.trim()) as {
        error: {
          code: string;
          details?: {
            foreign_live?: {
              pid: number;
              recorded_version: string;
              current_version: string;
            };
          };
        };
      };
      expect(envelope.error.code).toBe("NOT_RUNNING");
      expect(envelope.error.details?.foreign_live).toEqual({
        pid: stubborn.pid,
        recorded_version: "0.0.0-foreign-test",
        current_version: VERSION,
      });
    },
    SIGKILL_TEST_TIMEOUT_MS
  );

  // ───────────────────────────────────────────────────────────────────────────
  // Case 9: --status exit code is 3 when running:false
  // ───────────────────────────────────────────────────────────────────────────
  test(
    "case 9: --status exit code is 3 (NOT_RUNNING) when running:false; stdout still schema-clean",
    async () => {
      const pidFile = join(testDir, "data", "serve.pid");
      const logFile = join(testDir, "data", "serve.log");

      // No pid-file → still exit 3, with a parseable schema payload on stdout.
      const result = await runCli(
        [
          "serve",
          "--status",
          "--json",
          "--pid-file",
          pidFile,
          "--log-file",
          logFile,
        ],
        env
      );
      expect(result.code).toBe(3);
      const payload = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(payload.running).toBe(false);
      expect(payload.cmd).toBe("serve");
      expect(payload.pid).toBeNull();
    },
    TEST_TIMEOUT_MS
  );

  // ───────────────────────────────────────────────────────────────────────────
  // Case 10: sentinel flag is hidden from --help
  // ───────────────────────────────────────────────────────────────────────────
  test(
    "case 10: --help on serve and daemon does not leak the sentinel flag",
    async () => {
      const serveHelp = await runCli(["serve", "--help"], env);
      expect(serveHelp.code).toBe(0);
      // Pin the literal — if anyone ever changes the sentinel and forgets
      // to update Option#hideHelp(), this regression catches it.
      expect(serveHelp.stdout).not.toMatch(/--__detached-child/);

      const daemonHelp = await runCli(["daemon", "--help"], env);
      expect(daemonHelp.code).toBe(0);
      expect(daemonHelp.stdout).not.toMatch(/--__detached-child/);
    },
    TEST_TIMEOUT_MS
  );

  // ───────────────────────────────────────────────────────────────────────────
  // Case 11: --detach strips the flag before re-exec
  // ───────────────────────────────────────────────────────────────────────────
  test.skipIf(IS_WIN)(
    "case 11: detached child argv contains the sentinel and NOT --detach",
    async () => {
      await initSampleCollection(testDir, env);

      const spawned = await spawnServeDetached(testDir, env);
      spawnedPids.add(spawned.pid);
      // Wait a beat so the child finishes any setup that might mutate its
      // own argv (it doesn't, but the OS still needs to commit the cmdline
      // table before /proc reads stable).
      await Bun.sleep(150);

      const argv = await readLiveArgv(spawned.pid);
      // If we couldn't read the argv (rare permissions issue on macOS), skip
      // the assertion rather than fail flakily.
      if (!argv) {
        return;
      }

      // Sanity: the child's argv must include our entry script so we know we
      // read the right process.
      const argvJoined = argv.join(" ");
      expect(argvJoined).toMatch(/src\/index\.ts|index\.ts/);

      // Critical assertions: sentinel present, --detach absent. If the
      // detach branch ever forgets to strip --detach, the child re-spawns
      // itself in an infinite loop.
      expect(argvJoined).toContain(DETACHED_CHILD_FLAG);
      expect(argv).not.toContain("--detach");
    },
    SIGKILL_TEST_TIMEOUT_MS
  );

  // ───────────────────────────────────────────────────────────────────────────
  // Case 12: pid-file unlink on clean shutdown (SIGTERM)
  // ───────────────────────────────────────────────────────────────────────────
  test.skipIf(IS_WIN)(
    "case 12: SIGTERM the detached child → pid-file is removed after exit",
    async () => {
      await initSampleCollection(testDir, env);

      const spawned = await spawnServeDetached(testDir, env);
      spawnedPids.add(spawned.pid);
      await waitForHttpReady(requirePort(spawned));

      // Send SIGTERM directly so we exercise the installPidFileCleanup
      // handler installed in the detached-child branch (case 12 is
      // specifically about that handler, not about --stop).
      process.kill(spawned.pid, "SIGTERM");
      await waitForExit(spawned.pid, 10_000);

      // The cleanup runs sync via unlinkSync, so by the time the child
      // exits the file should be gone. Allow a tiny poll budget for the
      // OS to flush.
      await waitFor(
        async () => ((await pathExists(spawned.pidFile)) ? null : true),
        { timeoutMs: 3_000, label: "pid-file unlinked after SIGTERM" }
      );
    },
    SIGKILL_TEST_TIMEOUT_MS
  );

  // ───────────────────────────────────────────────────────────────────────────
  // Case 13: concurrent --status / --stop don't trip the start-lock
  // ───────────────────────────────────────────────────────────────────────────
  test.skipIf(IS_WIN)(
    "case 13: parallel --status / --stop invocations don't acquire the start-lock",
    async () => {
      await initSampleCollection(testDir, env);

      const spawned = await spawnServeDetached(testDir, env);
      spawnedPids.add(spawned.pid);
      await waitForHttpReady(requirePort(spawned));

      // Fire 3 concurrent --status calls and 1 concurrent --stop call. The
      // --stop wins exactly once; the --status calls must each return either
      // running:true or NOT_RUNNING. None of them are allowed to hit the
      // start-lock VALIDATION error — that lock is only acquired inside
      // spawnDetached.
      const statuses = await Promise.all([
        runCli(
          [
            "serve",
            "--status",
            "--json",
            "--pid-file",
            spawned.pidFile,
            "--log-file",
            spawned.logFile,
          ],
          env
        ),
        runCli(
          [
            "serve",
            "--status",
            "--json",
            "--pid-file",
            spawned.pidFile,
            "--log-file",
            spawned.logFile,
          ],
          env
        ),
        runCli(
          [
            "serve",
            "--status",
            "--json",
            "--pid-file",
            spawned.pidFile,
            "--log-file",
            spawned.logFile,
          ],
          env
        ),
        runCli(
          [
            "serve",
            "--stop",
            "--pid-file",
            spawned.pidFile,
            "--log-file",
            spawned.logFile,
          ],
          env,
          { timeoutMs: 20_000 }
        ),
      ]);

      // Stop returned 0 (or 3 if --status raced ahead of --stop and the
      // process was already gone — both are valid). What matters is that no
      // status/stop returned the VALIDATION code 1 with the start-lock
      // message.
      for (const r of statuses) {
        expect(r.stderr).not.toMatch(/another serve start is in progress/);
      }

      await waitForExit(spawned.pid, 10_000);
    },
    SIGKILL_TEST_TIMEOUT_MS
  );

  // ───────────────────────────────────────────────────────────────────────────
  // Case 14: live-foreign across status/stop/detach
  // ───────────────────────────────────────────────────────────────────────────
  test.skipIf(IS_WIN)(
    "case 14: live-foreign pid → status not-running, stop refuses (VALIDATION), detach refuses",
    async () => {
      await initSampleCollection(testDir, env);

      const pidFile = join(testDir, "data", "serve.pid");
      const logFile = join(testDir, "data", "serve.log");
      await mkdir(dirname(pidFile), { recursive: true });

      // Spawn a child we control so the pid is reliably alive throughout.
      const stubbornScript = join(testDir, "live-foreign.mjs");
      await writeFile(stubbornScript, `setInterval(() => {}, 1000);`);
      const foreign = Bun.spawn({
        cmd: [process.execPath, stubbornScript],
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
      });
      foreign.unref();
      spawnedPids.add(foreign.pid);

      const port = pickPort();
      const payload = {
        pid: foreign.pid,
        cmd: "serve",
        version: "0.0.0-foreign-test",
        started_at: new Date().toISOString(),
        port,
      };
      await writeFile(pidFile, `${JSON.stringify(payload)}\n`);

      // (a) --status reports running:false via the version cross-check.
      const status = await runCli(
        [
          "serve",
          "--status",
          "--json",
          "--pid-file",
          pidFile,
          "--log-file",
          logFile,
        ],
        env
      );
      expect(status.code).toBe(3);
      const statusPayload = JSON.parse(status.stdout) as Record<
        string,
        unknown
      >;
      expect(statusPayload.running).toBe(false);

      // (b) --stop refuses (VALIDATION) and does NOT signal the foreign pid.
      const stop = await runCli(
        ["serve", "--stop", "--pid-file", pidFile, "--log-file", logFile],
        env
      );
      expect(stop.code).toBe(1);
      expect(stop.stderr).toMatch(/Refusing to signal pid/i);
      // The foreign process must still be alive — the helper is forbidden
      // from signalling it.
      expect(isAlive(foreign.pid)).toBe(true);

      // (c) --detach refuses to start a second serve into the same data dir.
      const detach = await runCli(
        [
          "serve",
          "--detach",
          "--port",
          String(port),
          "--pid-file",
          pidFile,
          "--log-file",
          logFile,
        ],
        env
      );
      expect(detach.code).toBe(1);
      expect(detach.stderr).toMatch(
        /refusing to start|records a running serve/i
      );
      // Foreign still alive.
      expect(isAlive(foreign.pid)).toBe(true);
    },
    SIGKILL_TEST_TIMEOUT_MS
  );

  // ───────────────────────────────────────────────────────────────────────────
  // Case 15: start-lock recovery
  // ───────────────────────────────────────────────────────────────────────────
  test.skipIf(IS_WIN)(
    "case 15: stale .startlock auto-unlinks; fresh lock blocks second detach",
    async () => {
      await initSampleCollection(testDir, env);

      const pidFile = join(testDir, "data", "serve.pid");
      const logFile = join(testDir, "data", "serve.log");
      await mkdir(dirname(pidFile), { recursive: true });

      // (a) Stale lock: create a sidecar whose mtime is well past 30s old.
      // detach.ts STALE_LOCK_MS is 30_000; we use 60s for a comfortable
      // buffer. utimesSync takes seconds-since-epoch and is portable across
      // macOS/Linux without shelling out to `touch` (whose `-t` / `-d` flag
      // surface differs between BSD and GNU).
      const lockPath = `${pidFile}.startlock`;
      const fd = openSync(lockPath, "w");
      closeSync(fd);
      const sixtySecondsAgo = (Date.now() - 60_000) / 1000;
      utimesSync(lockPath, sixtySecondsAgo, sixtySecondsAgo);

      // detach should auto-recover and succeed.
      const port = pickPort();
      const recovered = await runCli(
        [
          "serve",
          "--detach",
          "--port",
          String(port),
          "--pid-file",
          pidFile,
          "--log-file",
          logFile,
        ],
        env
      );
      expect(recovered.code).toBe(0);
      const live = await readJsonFile<{ pid: number }>(pidFile);
      spawnedPids.add(live.pid);

      // Stop the recovered serve so we can exercise the fresh-lock case in
      // a clean state.
      await runCli(
        ["serve", "--stop", "--pid-file", pidFile, "--log-file", logFile],
        env,
        { timeoutMs: 20_000 }
      );
      await waitForExit(live.pid, 5_000);

      // (b) Fresh lock (created NOW) → second detach must fail fast.
      const freshFd = openSync(lockPath, "w");
      closeSync(freshFd);

      const blocked = await runCli(
        [
          "serve",
          "--detach",
          "--port",
          String(pickPort()),
          "--pid-file",
          pidFile,
          "--log-file",
          logFile,
        ],
        env
      );
      expect(blocked.code).toBe(1);
      expect(blocked.stderr).toMatch(/another serve start is in progress/);
    },
    SIGKILL_TEST_TIMEOUT_MS
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Test suite — Windows-only (case 16)
// ─────────────────────────────────────────────────────────────────────────────

describe("detach integration (Windows)", () => {
  let testDir: string;
  let env: CliEnv;

  beforeEach(async () => {
    testDir = await makeTestDir("gno-detach-int-win");
    env = envForTestDir(testDir);
  });

  afterEach(async () => {
    await safeRm(testDir);
  });

  test.skipIf(!IS_WIN)(
    "case 16: serve --detach exits 1 with VALIDATION + WSL guidance",
    async () => {
      const pidFile = join(testDir, "data", "serve.pid");
      const logFile = join(testDir, "data", "serve.log");
      const result = await runCli(
        [
          "serve",
          "--detach",
          "--port",
          "3000",
          "--pid-file",
          pidFile,
          "--log-file",
          logFile,
        ],
        env
      );
      expect(result.code).toBe(1);
      // Spec: clean VALIDATION error pointing the user to WSL.
      expect(result.stderr).toMatch(/Windows/i);
      expect(result.stderr).toMatch(/WSL/i);
    },
    TEST_TIMEOUT_MS
  );
});
