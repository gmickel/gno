import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises provides temp-directory lifecycle without a Bun equivalent.
import { mkdir, mkdtemp } from "node:fs/promises";
// node:os provides the temporary root.
import { tmpdir } from "node:os";
// node:path has no Bun path utilities.
import { join } from "node:path";

import { acquireWriteLock } from "../../src/core/file-lock";
import {
  acquireCliWriteLease,
  holderSidecarPath,
  parseLockWaitMs,
  writeLeasePath,
} from "../../src/core/write-lease";
import { safeRm } from "../helpers/cleanup";

const HOLDER_SCRIPT = join(
  import.meta.dir,
  "..",
  "fixtures",
  "write-lease-holder.ts"
);

const tempRoots: string[] = [];
const children: Array<ReturnType<typeof Bun.spawn>> = [];

async function createDbFixture(): Promise<string> {
  const temp = await mkdtemp(join(tmpdir(), "gno-write-lease-"));
  tempRoots.push(temp);
  const dbDir = join(temp, "data");
  await mkdir(dbDir, { recursive: true });
  return join(dbDir, "index-default.sqlite");
}

async function waitForReady(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs = 5_000
): Promise<void> {
  if (!proc.stdout || typeof proc.stdout === "number") {
    throw new Error("holder stdout is not a stream");
  }
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (!buffer.includes("ready")) {
      if (Date.now() > deadline) {
        throw new Error("holder did not become ready");
      }
      const result = await Promise.race([
        reader.read(),
        Bun.sleep(deadline - Date.now()).then(() => null),
      ]);
      if (!result || result.done || !result.value) {
        throw new Error("holder exited before ready");
      }
      buffer += decoder.decode(result.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function spawnHolder(
  mode: "lease" | "lock",
  dbPath: string,
  holdMs: number,
  command = "gno index growth-factors"
): ReturnType<typeof Bun.spawn> {
  const child = Bun.spawn(
    [process.execPath, HOLDER_SCRIPT, mode, dbPath, String(holdMs), command],
    { stdout: "pipe", stderr: "pipe" }
  );
  children.push(child);
  return child;
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await child.exited.catch(() => undefined);
  }
  for (const path of tempRoots.splice(0)) {
    await safeRm(path);
  }
});

describe("parseLockWaitMs", () => {
  test("accepts plain seconds, s suffix, and minutes", () => {
    expect(parseLockWaitMs("120")).toBe(120_000);
    expect(parseLockWaitMs("120s")).toBe(120_000);
    expect(parseLockWaitMs("2m")).toBe(120_000);
    expect(parseLockWaitMs(0)).toBe(0);
  });

  test("rejects invalid durations", () => {
    expect(parseLockWaitMs("abc")).toBeNull();
    expect(parseLockWaitMs("2h")).toBeNull();
    expect(parseLockWaitMs("1.5s")).toBeNull();
    expect(parseLockWaitMs("-1")).toBeNull();
  });
});

describe("acquireCliWriteLease", () => {
  test("waits for a holder subprocess then acquires (R2)", async () => {
    const dbPath = await createDbFixture();
    const child = spawnHolder("lease", dbPath, 2_000);
    await waitForReady(child);

    const startedAt = Date.now();
    const result = await acquireCliWriteLease({
      dbPath,
      waitMs: 10_000,
      command: "gno index projects",
    });
    const elapsed = Date.now() - startedAt;

    expect(result.ok).toBe(true);
    expect(elapsed).toBeGreaterThan(500);
    expect(elapsed).toBeLessThan(8_000);
    if (result.ok) {
      await result.release();
    }
    await child.exited;
  }, 15_000);

  test("acquires promptly after SIGKILL of the holder (R8)", async () => {
    const dbPath = await createDbFixture();
    const child = spawnHolder("lease", dbPath, 30_000);
    await waitForReady(child);
    child.kill("SIGKILL");
    await child.exited;

    const startedAt = Date.now();
    const result = await acquireCliWriteLease({
      dbPath,
      waitMs: 10_000,
    });
    const elapsed = Date.now() - startedAt;

    expect(result.ok).toBe(true);
    expect(elapsed).toBeLessThan(3_000);
    if (result.ok) {
      await result.release();
    }
  }, 15_000);

  test("shares the acquireWriteLock namespace (R9)", async () => {
    const dbPath = await createDbFixture();
    const lock = await acquireWriteLock(writeLeasePath(dbPath), 1_000);
    expect(lock).not.toBeNull();

    const pending = acquireCliWriteLease({ dbPath, waitMs: 10_000 });
    await Bun.sleep(200);
    await lock?.release();

    const result = await pending;
    expect(result.ok).toBe(true);
    if (result.ok) {
      await result.release();
    }
  }, 15_000);

  test("noWait against a held lock times out immediately", async () => {
    const dbPath = await createDbFixture();
    const lock = await acquireWriteLock(writeLeasePath(dbPath), 1_000);
    expect(lock).not.toBeNull();

    const startedAt = Date.now();
    const result = await acquireCliWriteLease({
      dbPath,
      waitMs: 10_000,
      noWait: true,
    });
    const elapsed = Date.now() - startedAt;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.timedOut).toBe(true);
    }
    expect(elapsed).toBeLessThan(2_000);
    await lock?.release();
  });

  test("writes, reads, and deletes the holder sidecar", async () => {
    const dbPath = await createDbFixture();
    const lockPath = writeLeasePath(dbPath);
    const sidecar = holderSidecarPath(lockPath);

    const result = await acquireCliWriteLease({
      dbPath,
      waitMs: 1_000,
      command: "gno index growth-factors",
    });
    expect(result.ok).toBe(true);
    expect(await Bun.file(sidecar).exists()).toBe(true);

    const parsed = (await Bun.file(sidecar).json()) as {
      pid: number;
      command: string;
      startedAtIso: string;
    };
    expect(parsed.pid).toBe(process.pid);
    expect(parsed.command).toBe("gno index growth-factors");
    expect(typeof parsed.startedAtIso).toBe("string");

    if (result.ok) {
      await result.release();
    }
    expect(await Bun.file(sidecar).exists()).toBe(false);
  });

  test("dead-pid sidecar yields holder null", async () => {
    const dbPath = await createDbFixture();
    const lockPath = writeLeasePath(dbPath);
    const lock = await acquireWriteLock(lockPath, 1_000);
    expect(lock).not.toBeNull();

    const dead = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await dead.exited;
    await Bun.write(
      holderSidecarPath(lockPath),
      `${JSON.stringify({
        pid: dead.pid,
        command: "gno index growth-factors",
        startedAtIso: new Date().toISOString(),
      })}\n`
    );

    const result = await acquireCliWriteLease({
      dbPath,
      waitMs: 1_000,
      noWait: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.holder).toBeNull();
    }
    await lock?.release();
  });
});
