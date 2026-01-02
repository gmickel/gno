/**
 * OS-backed advisory file locking for MCP write operations.
 *
 * @module src/core/file-lock
 */

// node:fs/promises for mkdir (no Bun equivalent for recursive dir creation)
import { mkdir } from "node:fs/promises";
// node:path for dirname (no Bun path utils)
import { dirname } from "node:path";

import { MCP_ERRORS } from "./errors";
const DEFAULT_TIMEOUT_MS = 5000;
const HOLD_SECONDS = 60 * 60 * 24 * 365;
const READY_TOKEN = "READY";

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

export async function acquireWriteLock(
  lockPath: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<WriteLockHandle | null> {
  const cmd = resolveLockCommand();
  if (!cmd) {
    throw new Error("No lockf/flock available for write locking");
  }

  await mkdir(dirname(lockPath), { recursive: true });

  const timeoutSeconds = Math.max(0, Math.ceil(timeoutMs / 1000));
  const holdCommand = buildHoldCommand();
  const proc = Bun.spawn(
    [cmd.path, ...cmd.args(lockPath, timeoutSeconds, holdCommand)],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const ready = await waitForReady(proc);
  if (!ready) {
    proc.kill();
    await proc.exited.catch(() => undefined);
    return null;
  }

  return {
    release: async () => {
      proc.kill();
      await proc.exited.catch(() => undefined);
    },
  };
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
