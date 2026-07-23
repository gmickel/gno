/** REST-compatible facade over the resident JobManager. */

import type { JobManager, JobRecord } from "../core/job-manager";
import type { SyncResult } from "../ingestion";

const JOB_EXPIRATION_MS = 60 * 60 * 1000;

export type JobType = "add" | "sync" | "embed";

export interface JobProgress {
  current: number;
  total: number;
  currentFile?: string;
}

export interface JobStatus {
  id: string;
  type: JobType;
  status: "running" | "completed" | "failed";
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
  activeJobId: string;
}

export type StartJobResult = StartJobSuccess | StartJobError;

// Standalone fallback retained for unit fixtures that do not construct a resident.
let activeJobId: string | null = null;
const jobs = new Map<string, JobStatus>();

const fromResidentRecord = (record: JobRecord): JobStatus => ({
  id: record.id,
  type: record.type as JobType,
  status: record.status,
  createdAt: record.startedAt,
  progress: record.progress,
  result: record.result,
  error: record.error,
});

function cleanupExpiredJobs(now = Date.now()): void {
  for (const [id, job] of jobs) {
    if (job.status !== "running" && now - job.createdAt > JOB_EXPIRATION_MS) {
      jobs.delete(id);
    }
  }
}

export function startJob(
  type: JobType,
  fn: () => Promise<SyncResult>
): StartJobResult;
export function startJob(
  type: JobType,
  fn: () => Promise<SyncResult>,
  manager: JobManager
): Promise<StartJobResult>;
export function startJob(
  type: JobType,
  fn: () => Promise<SyncResult>,
  manager: JobManager | undefined
): StartJobResult | Promise<StartJobResult>;
export function startJob(
  type: JobType,
  fn: () => Promise<SyncResult>,
  manager?: JobManager
): StartJobResult | Promise<StartJobResult> {
  if (manager) {
    return manager.startJob(type, fn).then(
      (jobId) => ({ ok: true, jobId }),
      (error: unknown) => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        status: 409,
        activeJobId: manager.getActiveJob()?.id ?? "",
      })
    );
  }

  cleanupExpiredJobs();
  if (activeJobId) {
    return {
      ok: false,
      error: `Job ${activeJobId} already running`,
      status: 409,
      activeJobId,
    };
  }
  const jobId = crypto.randomUUID();
  activeJobId = jobId;
  jobs.set(jobId, {
    id: jobId,
    type,
    status: "running",
    createdAt: Date.now(),
  });
  Promise.resolve()
    .then(fn)
    .then((result) => {
      const job = jobs.get(jobId);
      if (job) {
        job.status = "completed";
        job.result = result;
      }
    })
    .catch((error: unknown) => {
      const job = jobs.get(jobId);
      if (job) {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
      }
    })
    .finally(() => {
      activeJobId = null;
    });
  return { ok: true, jobId };
}

export function getJobStatus(
  jobId: string,
  manager?: JobManager
): JobStatus | undefined {
  if (manager) {
    const record = manager.getJob(jobId);
    return record ? fromResidentRecord(record) : undefined;
  }
  cleanupExpiredJobs();
  return jobs.get(jobId);
}

export function getActiveJobId(manager?: JobManager): string | null {
  return manager?.getActiveJob()?.id ?? activeJobId;
}

export function getActiveJob(manager?: JobManager): JobStatus | null {
  if (manager) {
    const record = manager.getActiveJob();
    return record ? fromResidentRecord(record) : null;
  }
  return activeJobId ? (jobs.get(activeJobId) ?? null) : null;
}

export function updateJobProgress(
  jobId: string,
  progress: JobProgress,
  manager?: JobManager
): void {
  if (manager) {
    manager.updateJobProgress(jobId, progress);
    return;
  }
  const job = jobs.get(jobId);
  if (job) job.progress = progress;
}

export function getAllJobs(manager?: JobManager): JobStatus[] {
  if (manager) {
    const listed = manager.listJobs(100);
    return [...listed.active, ...listed.recent].map(fromResidentRecord);
  }
  cleanupExpiredJobs();
  return Array.from(jobs.values());
}

export function clearAllJobs(manager?: JobManager): void {
  if (manager) manager.clear();
  jobs.clear();
  activeJobId = null;
}
