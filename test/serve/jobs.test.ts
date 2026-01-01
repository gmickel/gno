/**
 * Tests for background job tracker.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { SyncResult } from '../../src/ingestion';
import {
  clearAllJobs,
  getActiveJobId,
  getAllJobs,
  getJobStatus,
  startJob,
  updateJobProgress,
} from '../../src/serve/jobs';

function mockSyncResult(overrides?: Partial<SyncResult>): SyncResult {
  return {
    collections: [],
    totalDurationMs: 0,
    totalFilesProcessed: 0,
    totalFilesAdded: 0,
    totalFilesUpdated: 0,
    totalFilesErrored: 0,
    totalFilesSkipped: 0,
    ...overrides,
  };
}

describe('jobs', () => {
  afterEach(() => {
    clearAllJobs();
  });

  test('startJob creates a running job', async () => {
    let resolveJob: (() => void) | undefined;
    const jobPromise = new Promise<void>((resolve) => {
      resolveJob = resolve;
    });

    const result = startJob('add', async () => {
      await jobPromise;
      return mockSyncResult({ totalDurationMs: 100 });
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const status = getJobStatus(result.jobId);
      expect(status?.status).toBe('running');
      expect(status?.type).toBe('add');
    }

    resolveJob?.();
    await new Promise((r) => setTimeout(r, 10));
  });

  test('startJob rejects when job already running', async () => {
    let resolveJob: (() => void) | undefined;
    const jobPromise = new Promise<void>((resolve) => {
      resolveJob = resolve;
    });

    // Start first job
    const first = startJob('add', async () => {
      await jobPromise;
      return mockSyncResult();
    });
    expect(first.ok).toBe(true);

    // Try to start second job
    const second = startJob('sync', async () => mockSyncResult());

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.status).toBe(409);
      expect(second.error).toContain('already running');
    }

    resolveJob?.();
    await new Promise((r) => setTimeout(r, 10));
  });

  test('job completes with result', async () => {
    const result = startJob('add', async () =>
      mockSyncResult({
        totalDurationMs: 100,
        totalFilesAdded: 5,
        totalFilesUpdated: 2,
      })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    await new Promise((r) => setTimeout(r, 50));

    const status = getJobStatus(result.jobId);
    expect(status?.status).toBe('completed');
    expect(status?.result?.totalFilesAdded).toBe(5);
    expect(getActiveJobId()).toBe(null);
  });

  test('job fails with error', async () => {
    const result = startJob('sync', () =>
      Promise.reject(new Error('Sync failed'))
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    await new Promise((r) => setTimeout(r, 50));

    const status = getJobStatus(result.jobId);
    expect(status?.status).toBe('failed');
    expect(status?.error).toBe('Sync failed');
    expect(getActiveJobId()).toBe(null);
  });

  test('getJobStatus returns undefined for unknown job', () => {
    const status = getJobStatus('nonexistent');
    expect(status).toBeUndefined();
  });

  test('updateJobProgress updates job progress', async () => {
    let resolveJob: (() => void) | undefined;
    const jobPromise = new Promise<void>((resolve) => {
      resolveJob = resolve;
    });

    const result = startJob('add', async () => {
      await jobPromise;
      return mockSyncResult();
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    updateJobProgress(result.jobId, {
      current: 5,
      total: 10,
      currentFile: 'test.md',
    });

    const status = getJobStatus(result.jobId);
    expect(status?.progress?.current).toBe(5);
    expect(status?.progress?.total).toBe(10);
    expect(status?.progress?.currentFile).toBe('test.md');

    resolveJob?.();
    await new Promise((r) => setTimeout(r, 10));
  });

  test('getAllJobs returns all jobs', async () => {
    const result = startJob('add', async () => mockSyncResult());
    expect(result.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 50));

    const all = getAllJobs();
    expect(all.length).toBe(1);
    expect(all[0]?.type).toBe('add');
  });

  test('allows new job after previous completes', async () => {
    // First job
    const first = startJob('add', async () => mockSyncResult());
    expect(first.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 50));
    expect(getActiveJobId()).toBe(null);

    // Second job should work
    const second = startJob('sync', async () => mockSyncResult());
    expect(second.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 50));
  });
});
