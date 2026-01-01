/**
 * Background job tracker for API write operations.
 * Simple in-memory tracking with global mutex (one job at a time).
 *
 * @module src/serve/jobs
 */

import type { SyncResult } from '../ingestion';

// Job expiration: 1 hour
const JOB_EXPIRATION_MS = 60 * 60 * 1000;

export type JobType = 'add' | 'sync' | 'embed';

export interface JobProgress {
  current: number;
  total: number;
  currentFile?: string;
}

export interface JobStatus {
  id: string;
  type: JobType;
  status: 'running' | 'completed' | 'failed';
  createdAt: number;
  progress?: JobProgress;
  result?: SyncResult;
  error?: string;
}

export interface StartJobSuccess {
  ok: true;
  jobId: string;
}

export interface StartJobError {
  ok: false;
  error: string;
  status: 409;
}

export type StartJobResult = StartJobSuccess | StartJobError;

// Global state - only one job can run at a time
let activeJobId: string | null = null;
const jobs = new Map<string, JobStatus>();

/**
 * Clean up expired jobs to prevent memory leaks.
 * Called on every job access.
 * Only expires completed/failed jobs - running jobs are never expired.
 */
function cleanupExpiredJobs(now = Date.now()): void {
  for (const [id, job] of jobs) {
    // Never expire running jobs - only completed/failed
    if (job.status === 'running') {
      continue;
    }
    if (now - job.createdAt > JOB_EXPIRATION_MS) {
      jobs.delete(id);
    }
  }
}

/**
 * Start a background job.
 * Returns immediately with jobId; caller polls /api/jobs/:id for status.
 * Use updateJobProgress() to update progress during execution.
 *
 * @param type - Job type identifier
 * @param fn - Async function to run in background
 * @returns Job ID on success, or 409 error if job already running
 */
export function startJob(
  type: JobType,
  fn: () => Promise<SyncResult>
): StartJobResult {
  // Cleanup expired jobs first
  cleanupExpiredJobs();

  // Check if a job is already running
  if (activeJobId) {
    return {
      ok: false,
      error: `Job ${activeJobId} already running`,
      status: 409,
    };
  }

  const jobId = crypto.randomUUID();
  activeJobId = jobId;

  const jobStatus: JobStatus = {
    id: jobId,
    type,
    status: 'running',
    createdAt: Date.now(),
  };
  jobs.set(jobId, jobStatus);

  // Run in background (don't await)
  // Wrap with Promise.resolve().then() to catch sync throws from fn()
  // Without this, a sync throw would leave activeJobId set forever (deadlock)
  Promise.resolve()
    .then(fn)
    .then((result) => {
      const job = jobs.get(jobId);
      if (job) {
        job.status = 'completed';
        job.result = result;
      }
    })
    .catch((e) => {
      const job = jobs.get(jobId);
      if (job) {
        job.status = 'failed';
        job.error = e instanceof Error ? e.message : String(e);
      }
    })
    .finally(() => {
      activeJobId = null;
    });

  return { ok: true, jobId };
}

/**
 * Get current status of a job.
 *
 * @param jobId - Job ID from startJob
 * @returns Job status or undefined if not found
 */
export function getJobStatus(jobId: string): JobStatus | undefined {
  cleanupExpiredJobs();
  return jobs.get(jobId);
}

/**
 * Get the currently active job ID, if any.
 */
export function getActiveJobId(): string | null {
  return activeJobId;
}

/**
 * Update job progress (called from within job execution).
 *
 * @param jobId - Job ID to update
 * @param progress - Current progress info
 */
export function updateJobProgress(jobId: string, progress: JobProgress): void {
  const job = jobs.get(jobId);
  if (job) {
    job.progress = progress;
  }
}

/**
 * Get all jobs (for debugging/monitoring).
 */
export function getAllJobs(): JobStatus[] {
  cleanupExpiredJobs();
  return Array.from(jobs.values());
}

/**
 * Clear all jobs (for testing).
 */
export function clearAllJobs(): void {
  jobs.clear();
  activeJobId = null;
}
