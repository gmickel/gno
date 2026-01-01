/**
 * Tests for cross-process lockfile.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireLock,
  getLockPath,
  getManifestLockPath,
  withLock,
} from '../../src/llm/lockfile';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `gno-lockfile-test-${Date.now()}-${Math.random()}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('acquireLock', () => {
  test('acquires lock on fresh path', async () => {
    const lockPath = join(testDir, 'test.lock');
    const lock = await acquireLock(lockPath);

    expect(lock).not.toBeNull();
    expect(lock?.path).toBe(lockPath);

    // Lock file should exist
    const exists = await stat(lockPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);

    await lock?.release();
  });

  test('releases lock properly', async () => {
    const lockPath = join(testDir, 'test.lock');
    const lock = await acquireLock(lockPath);
    expect(lock).not.toBeNull();

    await lock?.release();

    // Lock file should be gone
    const exists = await stat(lockPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  test('blocks concurrent acquisition', async () => {
    const lockPath = join(testDir, 'test.lock');

    // Acquire first lock
    const lock1 = await acquireLock(lockPath);
    expect(lock1).not.toBeNull();

    // Second acquisition should fail quickly with low retries
    const lock2 = await acquireLock(lockPath, {
      maxRetries: 3,
      retryDelayMs: 10,
    });
    expect(lock2).toBeNull();

    await lock1?.release();
  });

  test('succeeds after previous lock released', async () => {
    const lockPath = join(testDir, 'test.lock');

    // Acquire and release
    const lock1 = await acquireLock(lockPath);
    expect(lock1).not.toBeNull();
    await lock1?.release();

    // Should succeed now
    const lock2 = await acquireLock(lockPath);
    expect(lock2).not.toBeNull();
    await lock2?.release();
  });

  test('recovers stale lock', async () => {
    const lockPath = join(testDir, 'test.lock');

    // Acquire lock
    const lock1 = await acquireLock(lockPath);
    expect(lock1).not.toBeNull();

    // Don't release - simulate stale lock with very short TTL
    const lock2 = await acquireLock(lockPath, {
      ttlMs: 1, // 1ms TTL - immediately stale
      maxRetries: 5,
      retryDelayMs: 10,
    });

    // Should recover the stale lock
    expect(lock2).not.toBeNull();
    await lock2?.release();
  });
});

describe('withLock', () => {
  test('executes function while holding lock', async () => {
    const lockPath = join(testDir, 'test.lock');
    let executed = false;

    const result = await withLock(lockPath, () => {
      executed = true;
      return Promise.resolve('success');
    });

    expect(executed).toBe(true);
    expect(result).toBe('success');

    // Lock should be released
    const exists = await stat(lockPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  test('releases lock even on error', async () => {
    const lockPath = join(testDir, 'test.lock');

    try {
      await withLock(lockPath, () => {
        return Promise.reject(new Error('test error'));
      });
    } catch {
      // Expected
    }

    // Lock should be released
    const exists = await stat(lockPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  test('returns null when lock unavailable', async () => {
    const lockPath = join(testDir, 'test.lock');

    // Hold lock
    const lock = await acquireLock(lockPath);
    expect(lock).not.toBeNull();

    // withLock should fail
    const result = await withLock(lockPath, async () => 'success', {
      maxRetries: 2,
      retryDelayMs: 10,
    });
    expect(result).toBeNull();

    await lock?.release();
  });
});

describe('path helpers', () => {
  test('getLockPath appends .lock', () => {
    expect(getLockPath('/path/to/model.gguf')).toBe('/path/to/model.gguf.lock');
  });

  test('getManifestLockPath returns manifest.lock in dir', () => {
    expect(getManifestLockPath('/path/to/cache')).toBe(
      '/path/to/cache/manifest.lock'
    );
  });
});
