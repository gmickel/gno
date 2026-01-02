/**
 * Background job manager for MCP write operations.
 *
 * @module src/core/job-manager
 */

import type { SyncResult } from "../ingestion";

import { MCP_ERRORS } from "./errors";
import { acquireWriteLock, type WriteLockHandle } from "./file-lock";

const JOB_EXPIRATION_MS = 60 * 60 * 1000;
const JOB_MAX_RECENT = 100;
const DEFAULT_LOCK_TIMEOUT_MS = 5000;

export type JobType = "add" | "sync";

export type JobStatus = "running" | "completed" | "failed";

export interface JobRecord {
  id: string;
  type: JobType;
  status: JobStatus;
  startedAt: number;
  completedAt?: number;
  result?: SyncResult;
  error?: string;
  serverInstanceId: string;
}

export interface JobManagerOptions {
  lockPath: string;
  serverInstanceId: string;
  toolMutex: {
    acquire: () => Promise<() => void>;
  };
  lockTimeoutMs?: number;
}

export class JobError extends Error {
  code: "LOCKED" | "JOB_CONFLICT";

  constructor(code: "LOCKED" | "JOB_CONFLICT", message: string) {
    super(message);
    this.code = code;
    this.name = "JobError";
  }
}

export class JobManager {
  #lockPath: string;
  #serverInstanceId: string;
  #toolMutex: JobManagerOptions["toolMutex"];
  #lockTimeoutMs: number;
  #activeJobId: string | null = null;
  #jobs = new Map<string, JobRecord>();
  #activeJobs = new Set<Promise<void>>();

  constructor(options: JobManagerOptions) {
    this.#lockPath = options.lockPath;
    this.#serverInstanceId = options.serverInstanceId;
    this.#toolMutex = options.toolMutex;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  }

  async startJob(
    type: JobType,
    fn: () => Promise<SyncResult>
  ): Promise<string> {
    this.#cleanupExpiredJobs();

    if (this.#activeJobId) {
      throw new JobError(
        "JOB_CONFLICT",
        `${MCP_ERRORS.JOB_CONFLICT.message} (${this.#activeJobId})`
      );
    }

    const lock = await acquireWriteLock(this.#lockPath, this.#lockTimeoutMs);
    if (!lock) {
      throw new JobError("LOCKED", MCP_ERRORS.LOCKED.message);
    }

    return this.#startJobWithLock(type, fn, lock);
  }

  async startJobWithLock(
    type: JobType,
    lock: WriteLockHandle,
    fn: () => Promise<SyncResult>
  ): Promise<string> {
    this.#cleanupExpiredJobs();

    if (this.#activeJobId) {
      throw new JobError(
        "JOB_CONFLICT",
        `${MCP_ERRORS.JOB_CONFLICT.message} (${this.#activeJobId})`
      );
    }

    return this.#startJobWithLock(type, fn, lock);
  }

  getJob(jobId: string): JobRecord | undefined {
    this.#cleanupExpiredJobs();
    return this.#jobs.get(jobId);
  }

  listJobs(limit: number = 10): { active: JobRecord[]; recent: JobRecord[] } {
    this.#cleanupExpiredJobs();

    const jobs = Array.from(this.#jobs.values());
    const active = jobs
      .filter((job) => job.status === "running")
      .sort((a, b) => a.startedAt - b.startedAt);

    const recent = jobs
      .filter((job) => job.status !== "running")
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
      .slice(0, limit);

    return { active, recent };
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(this.#activeJobs);
  }

  #track(jobPromise: Promise<void>): void {
    const tracked = jobPromise.catch(() => undefined);
    this.#activeJobs.add(tracked);
    void tracked.finally(() => {
      this.#activeJobs.delete(tracked);
    });
  }

  async #runJob(
    job: JobRecord,
    fn: () => Promise<SyncResult>,
    lock: { release: () => Promise<void> }
  ): Promise<void> {
    try {
      const release = await this.#toolMutex.acquire();
      try {
        const result = await fn();
        job.status = "completed";
        job.result = result;
      } catch (e) {
        job.status = "failed";
        job.error = e instanceof Error ? e.message : String(e);
      } finally {
        release();
      }
    } catch (e) {
      job.status = "failed";
      job.error = e instanceof Error ? e.message : String(e);
    } finally {
      job.completedAt = Date.now();
      this.#activeJobId = null;
      await lock.release().catch(() => undefined);
      this.#cleanupExpiredJobs();
    }
  }

  #startJobWithLock(
    type: JobType,
    fn: () => Promise<SyncResult>,
    lock: WriteLockHandle
  ): string {
    const jobId = crypto.randomUUID();
    const job: JobRecord = {
      id: jobId,
      type,
      status: "running",
      startedAt: Date.now(),
      serverInstanceId: this.#serverInstanceId,
    };

    this.#jobs.set(jobId, job);
    this.#activeJobId = jobId;

    const jobPromise = this.#runJob(job, fn, lock);
    this.#track(jobPromise);

    return jobId;
  }

  #cleanupExpiredJobs(now: number = Date.now()): void {
    for (const [id, job] of this.#jobs) {
      if (job.status === "running") {
        continue;
      }
      const completedAt = job.completedAt ?? job.startedAt;
      if (now - completedAt > JOB_EXPIRATION_MS) {
        this.#jobs.delete(id);
      }
    }

    const completed = Array.from(this.#jobs.values())
      .filter((job) => job.status !== "running")
      .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));

    if (completed.length <= JOB_MAX_RECENT) {
      return;
    }

    const toRemove = completed.length - JOB_MAX_RECENT;
    for (let i = 0; i < toRemove; i++) {
      const job = completed[i];
      if (job) {
        this.#jobs.delete(job.id);
      }
    }
  }
}
