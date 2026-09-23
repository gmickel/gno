import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
// node:fs/promises provides temporary-directory lifecycle and directory listing without Bun equivalents.
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
// node:os provides the temporary root.
import { tmpdir } from "node:os";
// node:path has no Bun path utilities.
import { dirname, join } from "node:path";

import {
  acquireSqliteWriteLock,
  acquireWriteLock,
  withSqliteWriteLock,
} from "../../src/core/file-lock";
import { safeRm } from "../helpers/cleanup";

const tempRoots: string[] = [];

async function createLockFixture(label: string): Promise<{
  lockPath: string;
  lockDirectory: string;
}> {
  const temp = await mkdtemp(join(tmpdir(), `gno-file-lock-${label}-`));
  tempRoots.push(temp);
  const lockPath = join(temp, "locks", "write.lock");
  const lockDirectory = dirname(lockPath);
  await mkdir(lockDirectory, { recursive: true });
  return { lockPath, lockDirectory };
}

afterEach(async () => {
  for (const path of tempRoots.splice(0)) {
    await safeRm(path);
  }
});

describe("SQLite write-lock fallback", () => {
  test("blocks concurrent acquisition while the current handle is active", async () => {
    const fixture = await createLockFixture("contention");
    const first = await acquireSqliteWriteLock(fixture.lockPath, 100);
    expect(first).not.toBeNull();

    const blocked = await acquireSqliteWriteLock(fixture.lockPath, 20);
    expect(blocked).toBeNull();
    await first?.release();
  });

  test("lets a same-process owner release while a contender waits", async () => {
    const fixture = await createLockFixture("async-contention");
    const first = await acquireSqliteWriteLock(fixture.lockPath, 0);
    expect(first).not.toBeNull();
    const attempted = Promise.withResolvers<void>();
    // Preserve the real method; the spy below binds each actual database via call.
    // oxlint-disable-next-line typescript-eslint/unbound-method
    const originalExec = Database.prototype.exec;
    const execSpy = spyOn(Database.prototype, "exec").mockImplementation(
      function (this: Database, sql, ...bindings) {
        if (sql === "BEGIN IMMEDIATE") attempted.resolve();
        return originalExec.call(this, sql, ...bindings);
      }
    );
    let contender:
      | Promise<Awaited<ReturnType<typeof acquireSqliteWriteLock>>>
      | undefined;
    try {
      contender = acquireSqliteWriteLock(fixture.lockPath, 250);
      // The contender has actually attempted the locked transaction before
      // releasing the owner; a synchronous busy wait prevents this release.
      await attempted.promise;
      await first?.release();
      expect(await contender).not.toBeNull();
    } finally {
      execSpy.mockRestore();
      await first?.release();
      await (await contender)?.release();
    }
  });

  test("zero timeout acquires once and reports immediate contention", async () => {
    const fixture = await createLockFixture("zero-timeout");
    const first = await acquireSqliteWriteLock(fixture.lockPath, 0);
    expect(first).not.toBeNull();
    try {
      expect(await acquireSqliteWriteLock(fixture.lockPath, 0)).toBeNull();
    } finally {
      await first?.release();
    }
    const next = await acquireSqliteWriteLock(fixture.lockPath, 0);
    expect(next).not.toBeNull();
    await next?.release();
  });

  test("permits the next acquisition after release", async () => {
    const fixture = await createLockFixture("release");
    const first = await acquireSqliteWriteLock(fixture.lockPath, 100);
    expect(first).not.toBeNull();
    await first?.release();

    const next = await acquireSqliteWriteLock(fixture.lockPath, 100);
    expect(next).not.toBeNull();
    await next?.release();
  });

  test("callback errors release the transaction lock", async () => {
    const fixture = await createLockFixture("callback-error");

    let callbackError: unknown;
    try {
      await withSqliteWriteLock(fixture.lockPath, async () => {
        throw new Error("expected callback failure");
      });
    } catch (cause) {
      callbackError = cause;
    }
    expect(callbackError).toBeInstanceOf(Error);
    expect((callbackError as Error).message).toBe("expected callback failure");

    const next = await acquireSqliteWriteLock(fixture.lockPath, 100);
    expect(next).not.toBeNull();
    await next?.release();
  });

  test("leaves only the persistent lock database, never ownership artifacts", async () => {
    const fixture = await createLockFixture("artifacts");
    const lock = await acquireSqliteWriteLock(fixture.lockPath, 100);
    expect(lock).not.toBeNull();
    await lock?.release();

    const entries = await readdir(fixture.lockDirectory);
    expect(entries).toContain("write.lock.sqlite");
    expect(entries.some((entry) => entry.includes(".candidate"))).toBe(false);
    expect(entries.some((entry) => entry.endsWith(".dir"))).toBe(false);
  });
});

describe("OS-backed advisory write lock", () => {
  test("releases the actual lock holder before resolving", async () => {
    const fixture = await createLockFixture("os-release");
    const first = await acquireWriteLock(fixture.lockPath, 100);
    expect(first).not.toBeNull();

    const blocked = await acquireWriteLock(fixture.lockPath, 10);
    expect(blocked).toBeNull();
    await first?.release();

    const next = await acquireWriteLock(fixture.lockPath, 100);
    expect(next).not.toBeNull();
    await next?.release();
  });
});
