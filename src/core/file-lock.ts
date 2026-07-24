/**
 * OS-backed advisory file locking for MCP write operations.
 *
 * @module src/core/file-lock
 */

import { Database } from "bun:sqlite";
// node:fs/promises provides recursive directory creation without a Bun equivalent.
import { mkdir } from "node:fs/promises";
// node:path for dirname (no Bun path utils)
import { dirname } from "node:path";

import { MCP_ERRORS } from "./errors";
const DEFAULT_TIMEOUT_MS = 5000;
const HOLD_SECONDS = 60 * 60 * 24 * 365;
const READY_TOKEN = "READY";
const SQLITE_LOCK_SUFFIX = ".sqlite";
const MAX_BUSY_TIMEOUT_MS = 60_000;

export interface WriteLockHandle {
  release: () => Promise<void>;
}

interface LockCommand {
  path: string;
  args: (
    lockPath: string,
    timeoutSeconds: number,
    holdCommand: string
  ) => string[];
}

function resolveLockCommand(): LockCommand | null {
  const lockfPath = Bun.which("lockf");
  if (lockfPath) {
    return {
      path: lockfPath,
      args: (lockPath, timeoutSeconds, holdCommand) => [
        "-k",
        "-t",
        String(timeoutSeconds),
        lockPath,
        "sh",
        "-c",
        holdCommand,
      ],
    };
  }

  const flockPath = Bun.which("flock");
  if (flockPath) {
    return {
      path: flockPath,
      args: (lockPath, timeoutSeconds, holdCommand) => [
        "--no-fork",
        "-w",
        String(timeoutSeconds),
        lockPath,
        "sh",
        "-c",
        holdCommand,
      ],
    };
  }

  return null;
}

function buildHoldCommand(): string {
  return `printf '${READY_TOKEN}\\n'; exec sleep ${HOLD_SECONDS}`;
}

async function waitForReady(
  proc: ReturnType<typeof Bun.spawn>
): Promise<boolean> {
  if (!proc.stdout || typeof proc.stdout === "number") {
    return false;
  }

  const reader = proc.stdout.getReader();
  try {
    const result = await Promise.race([
      reader.read(),
      proc.exited.then(() => null),
    ]);

    if (!result || result.done || !result.value) {
      return false;
    }

    const text = new TextDecoder().decode(result.value);
    return text.includes(READY_TOKEN);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function terminateLockProcess(
  proc: ReturnType<typeof Bun.spawn>
): Promise<void> {
  if (process.platform === "win32") {
    if (proc.exitCode === null) proc.kill();
  } else {
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      if (proc.exitCode === null) proc.kill();
    }
  }
  await proc.exited.catch(() => undefined);
}

function sqliteLockPath(lockPath: string): string {
  return `${lockPath}${SQLITE_LOCK_SUFFIX}`;
}

function normalizedBusyTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.max(0, Math.floor(timeoutMs)), MAX_BUSY_TIMEOUT_MS);
}

function isSqliteLockContention(cause: unknown): boolean {
  if (cause === null || typeof cause !== "object") {
    return false;
  }
  const code = "code" in cause ? cause.code : undefined;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

export async function acquireSqliteWriteLock(
  lockPath: string,
  timeoutMs: number
): Promise<WriteLockHandle | null> {
  const databasePath = sqliteLockPath(lockPath);
  await mkdir(dirname(databasePath), { recursive: true });

  const database = new Database(databasePath, { create: true });
  try {
    database.exec(`PRAGMA busy_timeout = ${normalizedBusyTimeout(timeoutMs)}`);
    database.exec("BEGIN IMMEDIATE");
  } catch (cause) {
    database.close();
    if (isSqliteLockContention(cause)) {
      return null;
    }
    throw cause;
  }

  let released = false;
  return {
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      try {
        database.exec("ROLLBACK");
      } finally {
        database.close();
      }
    },
  };
}

export async function acquireWriteLock(
  lockPath: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<WriteLockHandle | null> {
  const cmd = resolveLockCommand();
  if (!cmd) {
    return acquireSqliteWriteLock(lockPath, timeoutMs);
  }

  await mkdir(dirname(lockPath), { recursive: true });

  const timeoutSeconds = Math.max(0, Math.ceil(timeoutMs / 1000));
  const holdCommand = buildHoldCommand();
  const proc = Bun.spawn(
    [cmd.path, ...cmd.args(lockPath, timeoutSeconds, holdCommand)],
    {
      detached: true,
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const ready = await waitForReady(proc);
  if (!ready) {
    await terminateLockProcess(proc);
    return null;
  }

  return {
    release: () => terminateLockProcess(proc),
  };
}

export async function withSqliteWriteLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<T> {
  const lock = await acquireSqliteWriteLock(lockPath, timeoutMs);
  if (!lock) {
    throw new Error(`${MCP_ERRORS.LOCKED.code}: ${MCP_ERRORS.LOCKED.message}`);
  }

  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

export async function withWriteLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<T> {
  const lock = await acquireWriteLock(lockPath, timeoutMs);
  if (!lock) {
    throw new Error(`${MCP_ERRORS.LOCKED.code}: ${MCP_ERRORS.LOCKED.message}`);
  }

  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
