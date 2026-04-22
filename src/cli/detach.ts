/**
 * Shared self-backgrounding helper for `gno serve` and `gno daemon`.
 *
 * Wires `--detach`/`--pid-file`/`--log-file`/`--status`/`--stop` behind a
 * single entry-point so both commands stay in lockstep. The Bun spawn
 * invariants documented here (numeric-fd stdio + `.unref()`) are load-bearing:
 * see `.flow/tasks/fn-72-backgrounding-flags-for-serve-and-daemon.9.md` for
 * the spike that validated them in this repo.
 *
 * @module src/cli/detach
 */

// node:fs.openSync/closeSync — Bun has no equivalent and we specifically need
// a numeric fd (not a `Bun.file()` object, which Bun closes on parent exit).
// We also use openSync with "wx" for atomic lock-file creation in
// guardDoubleStart.
import { closeSync, openSync, statSync, unlinkSync } from "node:fs";
// node:fs/promises — stat/unlink structural ops not covered by Bun APIs.
import { mkdir, stat, unlink } from "node:fs/promises";
// node:path — no Bun path utils.
import { dirname, join } from "node:path";

import { VERSION, resolveDirs } from "../app/constants";
import { toAbsolutePath } from "../config/paths";
import { atomicWrite } from "../core/file-ops";
import { CliError } from "./errors";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Which command the helper is acting on. */
export type DetachKind = "serve" | "daemon";

/** Paths the helper reads and writes for one kind. */
export interface ProcessPaths {
  pidFile: string;
  logFile: string;
}

/** Optional overrides collected from CLI flags. */
export interface ProcessPathOverrides {
  pidFile?: string;
  logFile?: string;
  cwd?: string;
}

/** Payload persisted in the pid-file. */
export interface PidFilePayload {
  pid: number;
  cmd: DetachKind;
  version: string;
  started_at: string;
  port?: number | null;
}

/** Result of a `--status` call (matches process-status@1.0). */
export interface ProcessStatus {
  running: boolean;
  pid: number | null;
  port: number | null;
  cmd: DetachKind;
  version: string | null;
  started_at: string | null;
  uptime_seconds: number | null;
  pid_file: string;
  log_file: string;
  log_size_bytes: number | null;
}

/**
 * Operator-facing ambiguity the `process-status@1.0` schema can't encode.
 *
 * Returned by `inspectForeignLive()` as a sidecar to `statusProcess()`. It
 * signals that a pid-file's pid is live and names the same command, but
 * records a different gno version — so we can't safely claim it as "ours".
 */
export interface ForeignLiveSignal {
  pid: number;
  recordedVersion: string;
  currentVersion: string;
}

/** Outcome classification for `stopProcess`. */
export type StopOutcome =
  | { kind: "not-running"; pidFile: string }
  | { kind: "stopped"; pid: number; signal: "SIGTERM" | "SIGKILL" }
  | { kind: "timeout"; pid: number }
  | {
      /**
       * Live pid whose version disagrees with this binary. We refused to
       * signal it because we can't prove identity. Caller must surface the
       * ambiguity to the operator (typically via a VALIDATION error).
       */
      kind: "foreign-live";
      pid: number;
      payload: PidFilePayload;
    };

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve pid/log file locations for a given kind.
 *
 * Defaults come from `resolveDirs().data` (honours `GNO_DATA_DIR`). User
 * overrides pass through `toAbsolutePath` so relative paths and `~` both work.
 */
export function resolveProcessPaths(
  kind: DetachKind,
  overrides: ProcessPathOverrides = {}
): ProcessPaths {
  const dataDir = resolveDirs().data;
  const defaults: ProcessPaths = {
    pidFile: join(dataDir, `${kind}.pid`),
    logFile: join(dataDir, `${kind}.log`),
  };

  return {
    pidFile: overrides.pidFile
      ? toAbsolutePath(overrides.pidFile, overrides.cwd)
      : defaults.pidFile,
    logFile: overrides.logFile
      ? toAbsolutePath(overrides.logFile, overrides.cwd)
      : defaults.logFile,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pid-file IO
// ─────────────────────────────────────────────────────────────────────────────

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return (
    value instanceof Error &&
    "code" in value &&
    typeof (value as NodeJS.ErrnoException).code === "string"
  );
}

function isDetachKind(value: unknown): value is DetachKind {
  return value === "serve" || value === "daemon";
}

/**
 * Read and validate a pid-file. Returns null when missing; throws on
 * permission errors; throws `CliError("RUNTIME")` on unparsable JSON.
 */
export async function readPidFile(
  path: string
): Promise<PidFilePayload | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return null;
  }

  let raw: string;
  try {
    raw = await file.text();
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CliError(
      "RUNTIME",
      `Pid-file is not valid JSON: ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("pid" in parsed) ||
    !("cmd" in parsed)
  ) {
    throw new CliError("RUNTIME", `Pid-file has unexpected shape: ${path}`);
  }

  const record = parsed as Record<string, unknown>;
  if (
    typeof record.pid !== "number" ||
    !Number.isInteger(record.pid) ||
    record.pid < 1
  ) {
    throw new CliError(
      "RUNTIME",
      `Pid-file has invalid pid (must be a positive integer): ${path}`
    );
  }
  if (!isDetachKind(record.cmd)) {
    throw new CliError(
      "RUNTIME",
      `Pid-file has invalid cmd (expected "serve" or "daemon"): ${path}`
    );
  }
  if (typeof record.version !== "string" || record.version.length === 0) {
    throw new CliError("RUNTIME", `Pid-file is missing version: ${path}`);
  }
  if (typeof record.started_at !== "string") {
    throw new CliError("RUNTIME", `Pid-file is missing started_at: ${path}`);
  }
  // started_at must be a parseable ISO datetime. An invalid value would later
  // produce NaN through Date.parse() and violate the process-status@1.0
  // schema invariant that live processes report an integer uptime_seconds.
  const startedAtMs = Date.parse(record.started_at);
  if (!Number.isFinite(startedAtMs)) {
    throw new CliError(
      "RUNTIME",
      `Pid-file has invalid started_at (not a parseable ISO datetime): ${path}`
    );
  }

  let port: number | null;
  if (record.port === null || record.port === undefined) {
    port = null;
  } else if (
    typeof record.port === "number" &&
    Number.isInteger(record.port) &&
    record.port >= 1 &&
    record.port <= 65_535
  ) {
    port = record.port;
  } else {
    throw new CliError(
      "RUNTIME",
      `Pid-file has invalid port (must be null or an integer in 1..65535): ${path}`
    );
  }

  return {
    pid: record.pid,
    cmd: record.cmd,
    version: record.version,
    started_at: record.started_at,
    port,
  };
}

/**
 * Atomically write pid-file JSON via `atomicWrite` from `src/core/file-ops.ts`.
 * Parent directory is created if missing.
 */
export async function writePidFile(
  path: string,
  payload: PidFilePayload
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await atomicWrite(path, `${JSON.stringify(payload)}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Liveness
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Probe whether a process is alive via `process.kill(pid, 0)`.
 *
 * - ESRCH → dead.
 * - EPERM → alive under a different user; we treat it as alive so callers
 *   don't incorrectly clean up someone else's pid.
 * - Any other errno → rethrown for the caller to surface.
 */
/**
 * SIGTERM then SIGKILL a child we spawned but failed to register, awaiting
 * its exit between each escalation. We keep the Bun subprocess handle so we
 * can `await child.exited` (a Promise that resolves when the OS reaps the
 * child) instead of relying on `kill -0`, which would report a zombie as
 * still alive. Called only from the pid-file-write-failure path.
 */
async function reapOrphanedChild(
  child: ReturnType<typeof Bun.spawn>
): Promise<void> {
  const pid = child.pid;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ESRCH") {
      return;
    }
    // EPERM or other: we can't signal it, nothing more to do.
    return;
  }

  // Wait up to 1s for SIGTERM to land.
  const raced = await Promise.race([
    child.exited,
    new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), 1000).unref();
    }),
  ]);
  if (raced !== "timeout") {
    return;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }

  // Wait up to 500ms for SIGKILL — bounded so the caller doesn't hang.
  await Promise.race([
    child.exited,
    new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 500).unref();
    }),
  ]);
}

/**
 * Child-side pid-file self-check. Polls the pid-file for a bounded window,
 * requiring that it eventually appear AND point at our pid. If the pid-file
 * never materializes (e.g. parent crashed between `Bun.spawn` and
 * `writePidFile`), or points at another pid (we're the losing racer in a
 * concurrent-start edge case), returns `false` so the child can exit
 * rather than boot unmanaged.
 *
 * Called from the child-side wiring in fn-72.3/.4 immediately after the
 * detach branch is skipped (`--__detached-child` sentinel present).
 *
 * Why a poll: the parent's spawn → pid-file-write sequence is not atomic.
 * The child may start before the parent finishes writing. Polling a few
 * hundred ms gives the parent time to register us without stalling the
 * child indefinitely on a legitimately crashed parent.
 */
export async function verifyPidFileMatchesSelf(options: {
  pidFile: string;
  selfPid?: number;
  /** Total wait budget for the pid-file to appear. Default 3s. */
  timeoutMs?: number;
  /** Poll interval while waiting. Default 50ms. */
  pollIntervalMs?: number;
  /** Sleep override for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}): Promise<boolean> {
  const selfPid = options.selfPid ?? process.pid;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const sleep = options.sleep ?? defaultSleep;

  const deadline = Date.now() + timeoutMs;
  // First pass: readPidFile now and if it already matches, short-circuit.
  // Then poll while the file is missing.
  while (Date.now() < deadline) {
    const payload = await readPidFile(options.pidFile);
    if (payload) {
      return payload.pid === selfPid;
    }
    await sleep(pollIntervalMs);
  }

  // Final check after the deadline so we don't lose a race in the last
  // poll interval.
  const payload = await readPidFile(options.pidFile);
  if (payload) {
    return payload.pid === selfPid;
  }

  // Parent never registered us — safest action is to exit so the operator
  // doesn't end up with an unmanaged orphan.
  return false;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrnoException(error)) {
      if (error.code === "ESRCH") {
        return false;
      }
      if (error.code === "EPERM") {
        return true;
      }
    }
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Spawn
// ─────────────────────────────────────────────────────────────────────────────

/** Sentinel flag appended to the child argv so the re-invoked body skips detach. */
export const DETACHED_CHILD_FLAG = "--__detached-child";

export interface SpawnDetachedOptions {
  kind: DetachKind;
  /**
   * Argv to re-invoke (typically `process.argv.slice(2)` minus `--detach`).
   *
   * By default we build the full child command as
   * `[execPath, entryScript, ...argv, DETACHED_CHILD_FLAG]`, where
   * `entryScript` comes from `process.argv[1]`. This matches how Bun and
   * Node launch a script (`bun src/index.ts serve` / `node dist/index.js
   * serve`). Tests or callers that want to run a standalone file can
   * override the prefix via `cmd` below.
   */
  argv: string[];
  pidFile: string;
  logFile: string;
  /** Extra env merged on top of `process.env`. */
  env?: Record<string, string | undefined>;
  /** Override for the parent executable path. Defaults to `process.execPath`. */
  execPath?: string;
  /**
   * Full child command prefix (everything before user argv). Defaults to
   * `[execPath, process.argv[1]]` so the re-exec matches the way Bun/Node
   * originally launched the parent. Omit `execPath` if you set this.
   */
  cmdPrefix?: string[];
  /**
   * Override for the script path passed to the child runtime. Defaults to
   * `process.argv[1]`. Set to `null` to omit (for callers passing a
   * self-contained executable like a single `.mjs` file).
   */
  entryScript?: string | null;
  /** Optional port to embed in the pid-file payload (serve only). */
  port?: number | null;
  /** Working directory for the child. Defaults to `process.cwd()`. */
  cwd?: string;
}

export interface SpawnDetachedResult {
  pid: number;
  pidFile: string;
  logFile: string;
  payload: PidFilePayload;
}

/**
 * Open the log file for append-only stdio redirection to the detached child.
 *
 * Must use a numeric fd (`openSync`), not `Bun.file()` — Bun closes the latter
 * on parent exit, which would immediately close the child's stdout/stderr.
 */
function openLogFd(logFile: string): number {
  return openSync(logFile, "a");
}

/**
 * Derive the start-lock path from a pid-file path. A sidecar lock-file that
 * exists only for the brief window between "decide to start" and "pid-file
 * durably written" serializes concurrent `--detach` invocations against
 * each other in the same `GNO_DATA_DIR`.
 */
function startLockPath(pidFile: string): string {
  return `${pidFile}.startlock`;
}

/**
 * Acquire an exclusive start-lock via `open(O_CREAT | O_EXCL)`. Returns the
 * lock path on success. Throws `CliError("VALIDATION")` if another starter
 * holds the lock. Stale locks (leftover from a crash) are detected via a
 * short age threshold and recovered automatically.
 */
function acquireStartLock(pidFile: string, kind: DetachKind): string {
  const lockPath = startLockPath(pidFile);
  // "wx" = O_CREAT | O_EXCL | O_WRONLY — atomic create-or-fail.
  try {
    const fd = openSync(lockPath, "wx");
    closeSync(fd);
    return lockPath;
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "EEXIST") {
      throw error;
    }
  }

  // Lock exists. If it's old (>30s), assume a previous start crashed before
  // releasing it — unlink and retry once.
  const STALE_LOCK_MS = 30_000;
  try {
    const info = statSync(lockPath);
    if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
      try {
        unlinkSync(lockPath);
      } catch {
        /* race with another cleanup — fall through */
      }
      try {
        const fd = openSync(lockPath, "wx");
        closeSync(fd);
        return lockPath;
      } catch {
        /* someone else won the retry */
      }
    }
  } catch {
    /* stat failed — treat as live lock */
  }

  throw new CliError(
    "VALIDATION",
    `another ${kind} start is in progress (lock-file ${lockPath}). If no other ${kind} start is running, delete the lock-file manually and retry.`
  );
}

function releaseStartLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    /* already gone — fine */
  }
}

/**
 * Spawn a detached background child, write the pid-file, and return the pid.
 *
 * Windows is explicitly unsupported: we throw a `CliError("VALIDATION")` with
 * guidance toward WSL. The rest of the helper (status/stop) remains safe to
 * call on Windows but has nothing to manage because no pid-file is ever
 * written.
 */
export async function spawnDetached(
  options: SpawnDetachedOptions
): Promise<SpawnDetachedResult> {
  if (process.platform === "win32") {
    throw new CliError(
      "VALIDATION",
      "`--detach` is not supported on Windows. Use WSL, or a Windows launcher like NSSM. See docs/WINDOWS.md."
    );
  }

  const execPath = options.execPath ?? process.execPath;
  const cwd = options.cwd ?? process.cwd();

  // Build the child command prefix. By default we re-invoke the same script
  // the parent was launched with (process.argv[1]), so `bun src/index.ts
  // serve --detach` spawns `bun src/index.ts serve ...` in the child rather
  // than `bun serve ...`. Callers can opt out by passing `entryScript: null`
  // (single-file executables) or override the prefix wholesale via
  // `cmdPrefix`.
  let cmdPrefix: string[];
  if (options.cmdPrefix) {
    cmdPrefix = options.cmdPrefix;
  } else {
    const entryScript =
      options.entryScript === undefined
        ? (process.argv[1] ?? null)
        : options.entryScript;
    cmdPrefix = entryScript === null ? [execPath] : [execPath, entryScript];
  }

  await mkdir(dirname(options.logFile), { recursive: true });
  await mkdir(dirname(options.pidFile), { recursive: true });

  // Serialize the guard+spawn+pid-file-write sequence against concurrent
  // `--detach` invocations via an atomic lock-file (O_CREAT | O_EXCL). Two
  // parents can't both pass `guardDoubleStart` and then both spawn children
  // into the same data dir — only one holds the lock at a time.
  const lockPath = acquireStartLock(options.pidFile, options.kind);

  let payload: PidFilePayload;
  let childPid: number;
  try {
    // Re-check the pid-file *under the lock*. An earlier concurrent starter
    // may have completed while we were waiting at file-system boundaries.
    await guardDoubleStart(options.pidFile, options.kind);

    const fd = openLogFd(options.logFile);
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn({
        cmd: [...cmdPrefix, ...options.argv, DETACHED_CHILD_FLAG],
        stdio: ["ignore", fd, fd],
        detached: true,
        cwd,
        env: { ...process.env, ...options.env },
      });
      // `.unref()` is mandatory — `detached: true` alone keeps the parent's
      // event loop tied to the child handle. See spike findings in
      // `.flow/tasks/fn-72-backgrounding-flags-for-serve-and-daemon.9.md`.
      child.unref();
    } finally {
      // The child has its own dup of the fd; closing the parent's copy is
      // safe and prevents leaking an fd in the parent.
      closeSync(fd);
    }
    childPid = child.pid;

    payload = {
      pid: child.pid,
      cmd: options.kind,
      version: VERSION,
      started_at: new Date().toISOString(),
      port: options.port ?? null,
    };

    // If the pid-file write fails (disk full, permission race, bad path on
    // an overridden --pid-file), we MUST NOT leave the child orphaned —
    // there'd be no pid-file for `--status`/`--stop` and the operator has
    // no way to find it. Synchronously reap the child: SIGTERM → poll →
    // SIGKILL → poll. This blocks until cleanup lands (or the timeout
    // budget is exhausted), so the CliError we throw reflects reality.
    try {
      await writePidFile(options.pidFile, payload);
    } catch (error) {
      await reapOrphanedChild(child);
      throw new CliError(
        "RUNTIME",
        `spawned ${options.kind} (pid ${child.pid}) but failed to write pid-file ${options.pidFile}; child was signaled and reaped. Original error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  } finally {
    releaseStartLock(lockPath);
  }

  return {
    pid: childPid,
    pidFile: options.pidFile,
    logFile: options.logFile,
    payload,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Guard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Does the pid-file's recorded version match the binary currently running?
 *
 * PID-reuse mitigation (per epic spec): after liveness passes we cross-check
 * the stored `cmd` *and* `version`. A mismatched version is a "live-foreign"
 * signal: we have a live pid claiming to be ours but we can't prove identity.
 * Two realistic causes:
 *
 *   (a) User upgraded gno while the old detached process is still running.
 *   (b) Original process crashed and an unrelated process inherited the pid.
 *
 * In neither case is it safe to issue signals to the pid, nor to
 * double-start into the same data dir, nor to claim "not running" — that
 * would lose track of (a) and let two detached processes fight over the
 * same port or watcher. Surface the ambiguity to the operator and make
 * them resolve it.
 */
function versionMatchesPidFile(payload: PidFilePayload): boolean {
  return payload.version === VERSION;
}

function formatLiveForeignError(
  kind: DetachKind,
  pidFile: string,
  existing: PidFilePayload,
  action: "start" | "stop" | "status"
): CliError {
  const hint =
    action === "start"
      ? `refusing to start a second ${kind}. If the old process is defunct, terminate it manually (\`kill ${existing.pid}\` or \`kill -9 ${existing.pid}\`) and delete ${pidFile}.`
      : action === "stop"
        ? `refusing to signal pid ${existing.pid} without stronger identity proof. Terminate the old process manually and delete ${pidFile}.`
        : `cannot verify liveness safely.`;
  return new CliError(
    "VALIDATION",
    `pid-file ${pidFile} records a running ${kind} (pid ${existing.pid}) from gno ${existing.version}, but this binary is ${VERSION}: ${hint}`
  );
}

/**
 * Block a second detach when a matching process is already running.
 *
 * - Live + matching `cmd` + matching `version` → throw `CliError("VALIDATION")`
 *   with pid/port hint.
 * - Live + mismatched `cmd` → throw (someone else's pid-file).
 * - Live + matching `cmd` but mismatched `version` → throw VALIDATION with
 *   operator guidance. This is live-foreign: we can't prove identity, so we
 *   neither double-start nor silently unlink an active pid.
 * - Dead (ESRCH) → unlink the stale pid-file and return.
 */
export async function guardDoubleStart(
  pidFile: string,
  kind: DetachKind
): Promise<void> {
  const existing = await readPidFile(pidFile);
  if (!existing) {
    return;
  }

  if (!isProcessAlive(existing.pid)) {
    await unlink(pidFile).catch(() => {
      /* stale — removed by someone else is fine */
    });
    return;
  }

  if (existing.cmd !== kind) {
    throw new CliError(
      "VALIDATION",
      `pid-file ${pidFile} is owned by a running ${existing.cmd} (pid ${existing.pid}), not ${kind}`
    );
  }

  if (!versionMatchesPidFile(existing)) {
    throw formatLiveForeignError(kind, pidFile, existing, "start");
  }

  const portSuffix =
    existing.port === null || existing.port === undefined
      ? ""
      : ` on port ${existing.port}`;
  throw new CliError(
    "VALIDATION",
    `${kind} is already running${portSuffix} (pid ${existing.pid}, pid-file ${pidFile})`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Status
// ─────────────────────────────────────────────────────────────────────────────

async function fileSizeOrNull(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.size;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export interface StatusOptions {
  kind: DetachKind;
  pidFile: string;
  logFile: string;
  /** Clock override for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Resolve the `process-status@1.0` payload for one process kind.
 *
 * Returns the bare schema-shape payload — callers can JSON-serialize it
 * directly for `--status --json`. For the operator-facing live-foreign
 * warning (a live pid whose recorded gno version disagrees with the current
 * binary), call `inspectForeignLive()` as a sidecar.
 *
 * Safe to call on Windows — without a pid-file the payload is simply
 * `running:false` with everything else null.
 */
export async function statusProcess(
  options: StatusOptions
): Promise<ProcessStatus> {
  const now = options.now ?? Date.now;
  const logSize = await fileSizeOrNull(options.logFile);
  const payload = await readPidFile(options.pidFile);

  if (!payload) {
    return {
      running: false,
      pid: null,
      port: null,
      cmd: options.kind,
      version: null,
      started_at: null,
      uptime_seconds: null,
      pid_file: options.pidFile,
      log_file: options.logFile,
      log_size_bytes: logSize,
    };
  }

  // Pid-file exists but declares a different kind → treat the entry as not
  // applicable to this status call (preserve the recorded metadata so
  // operators can see what is there, but mark not-running).
  const effectiveKind =
    payload.cmd === options.kind ? payload.cmd : options.kind;

  const alive = isProcessAlive(payload.pid);
  // Cross-check cmd AND version to mitigate PID reuse after a crash. A
  // mismatched version means the pid-file was written by a different gno
  // binary than the one currently running, so we can't trust the pid to
  // still be "ours".
  const kindMatches = payload.cmd === options.kind;
  const versionMatches = versionMatchesPidFile(payload);
  const running = alive && kindMatches && versionMatches;
  const uptimeSeconds = running
    ? Math.max(0, Math.floor((now() - Date.parse(payload.started_at)) / 1000))
    : null;

  // Schema invariant: a live serve must report a numeric port. If the pid-file
  // is missing one somehow, fall back to not-running rather than lying.
  const portForRunningServe =
    running && effectiveKind === "serve"
      ? typeof payload.port === "number"
        ? payload.port
        : null
      : running && effectiveKind === "daemon"
        ? null
        : (payload.port ?? null);

  const runningFinal =
    running && !(effectiveKind === "serve" && portForRunningServe === null);

  return {
    running: runningFinal,
    pid: payload.pid,
    port:
      runningFinal && effectiveKind === "serve"
        ? portForRunningServe
        : effectiveKind === "daemon"
          ? null
          : (payload.port ?? null),
    cmd: effectiveKind,
    version: payload.version,
    started_at: payload.started_at,
    uptime_seconds: runningFinal ? uptimeSeconds : null,
    pid_file: options.pidFile,
    log_file: options.logFile,
    log_size_bytes: logSize,
  };
}

/**
 * Inspect the pid-file for a "live-foreign" signal — a live pid whose
 * recorded gno version disagrees with the currently running binary. Returns
 * `null` when no pid-file, when the pid is dead, when cmds disagree, or
 * when versions match. Callers pair this with `statusProcess()` to surface
 * operator-facing ambiguity the schema doesn't encode.
 */
export async function inspectForeignLive(options: {
  kind: DetachKind;
  pidFile: string;
}): Promise<ForeignLiveSignal | null> {
  const payload = await readPidFile(options.pidFile);
  if (!payload) {
    return null;
  }
  if (payload.cmd !== options.kind) {
    return null;
  }
  if (!isProcessAlive(payload.pid)) {
    return null;
  }
  if (versionMatchesPidFile(payload)) {
    return null;
  }
  return {
    pid: payload.pid,
    recordedVersion: payload.version,
    currentVersion: VERSION,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stop
// ─────────────────────────────────────────────────────────────────────────────

export interface StopOptions {
  kind: DetachKind;
  pidFile: string;
  /** Grace period for SIGTERM before we escalate to SIGKILL. Default 10s. */
  timeoutMs?: number;
  /** Poll interval while waiting for the process to exit. Default 100ms. */
  pollIntervalMs?: number;
  /** Post-SIGKILL budget before giving up. Default 2s. */
  killTimeoutMs?: number;
  /** Sleep override for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** kill override for deterministic tests. */
  kill?: (pid: number, signal: NodeJS.Signals | number) => void;
  /** isAlive override for deterministic tests. */
  isAlive?: (pid: number) => boolean;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExit(
  pid: number,
  deadlineMs: number,
  pollIntervalMs: number,
  isAlive: (pid: number) => boolean,
  sleep: (ms: number) => Promise<void>
): Promise<boolean> {
  while (Date.now() < deadlineMs) {
    if (!isAlive(pid)) {
      return true;
    }
    await sleep(pollIntervalMs);
  }
  return !isAlive(pid);
}

/**
 * Stop a detached process: SIGTERM → poll → SIGKILL → poll → error.
 *
 * The pid-file is **not** unlinked on success by this helper — we let the
 * target's own signal handler clean it up (see `createSignalPromise` in
 * `src/cli/commands/daemon.ts`). Callers may unlink the file as a fallback
 * when liveness is `false` after the kill sequence; `stopProcess` itself only
 * unlinks stale pid-files it discovers on entry.
 */
export async function stopProcess(options: StopOptions): Promise<StopOutcome> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const killTimeoutMs = options.killTimeoutMs ?? 2_000;
  const sleep = options.sleep ?? defaultSleep;
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const isAlive = options.isAlive ?? isProcessAlive;

  const payload = await readPidFile(options.pidFile);
  if (!payload) {
    return { kind: "not-running", pidFile: options.pidFile };
  }

  if (!isAlive(payload.pid)) {
    // Stale: clean up as a best-effort fallback.
    await unlink(options.pidFile).catch(() => {
      /* ignore */
    });
    return { kind: "not-running", pidFile: options.pidFile };
  }

  if (payload.cmd !== options.kind) {
    throw new CliError(
      "VALIDATION",
      `pid-file ${options.pidFile} is owned by a running ${payload.cmd} (pid ${payload.pid}), not ${options.kind}`
    );
  }

  if (!versionMatchesPidFile(payload)) {
    // Live pid, matching kind, but a different gno version wrote the
    // pid-file. Could be an orphan from a pre-upgrade process we still
    // need to manage, or could be PID reuse — either way we can't prove
    // identity, so we MUST NOT send signals to that pid. Surface the
    // ambiguity and leave the pid-file in place for the operator.
    return { kind: "foreign-live", pid: payload.pid, payload };
  }

  try {
    kill(payload.pid, "SIGTERM");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ESRCH") {
      return { kind: "not-running", pidFile: options.pidFile };
    }
    throw error;
  }

  const sigtermDeadline = Date.now() + timeoutMs;
  const exitedOnSigterm = await waitForExit(
    payload.pid,
    sigtermDeadline,
    pollIntervalMs,
    isAlive,
    sleep
  );
  if (exitedOnSigterm) {
    return { kind: "stopped", pid: payload.pid, signal: "SIGTERM" };
  }

  try {
    kill(payload.pid, "SIGKILL");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ESRCH") {
      return { kind: "stopped", pid: payload.pid, signal: "SIGTERM" };
    }
    throw error;
  }

  const sigkillDeadline = Date.now() + killTimeoutMs;
  const exitedOnSigkill = await waitForExit(
    payload.pid,
    sigkillDeadline,
    pollIntervalMs,
    isAlive,
    sleep
  );
  if (exitedOnSigkill) {
    return { kind: "stopped", pid: payload.pid, signal: "SIGKILL" };
  }

  return { kind: "timeout", pid: payload.pid };
}
