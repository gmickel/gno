import { afterEach, describe, expect, test } from "bun:test";
// node:fs/promises provides temporary-directory lifecycle and directory listing without Bun equivalents.
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
// node:os provides the temporary root.
import { tmpdir } from "node:os";
// node:path has no Bun path utilities.
import { dirname, join } from "node:path";

import {
  acquireSqliteWriteLock,
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
