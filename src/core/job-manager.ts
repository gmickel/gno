// node:async_hooks: Bun has no separate async-context snapshot API.
import { AsyncLocalStorage } from "node:async_hooks";
/**
 * Background job manager for MCP write operations.
 *
 * @module src/core/job-manager
 */

import type { SyncResult } from "../ingestion";

import {
  assertInferenceActive,
  withOwnedInferenceScope,
  withBackgroundInference,
} from "../llm/inference-scope";
import { MCP_ERRORS } from "./errors";
import { acquireWriteLock, type WriteLockHandle } from "./file-lock";
import { MAX_REINDEX_PATHS } from "./reindex-paths";

const JOB_EXPIRATION_MS = 60 * 60 * 1000;
const JOB_MAX_RECENT = 100;
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
/** Distinct reindex requests that may wait behind the running job. */
export const MAX_PENDING_REINDEX_JOBS = 64;

export type JobType = "add" | "sync" | "embed" | "index";

export type JobStatus = "queued" | "running" | "completed" | "failed";

// ─────────────────────────────────────────────────────────────────────────────
// Discriminated union for job results
// ─────────────────────────────────────────────────────────────────────────────

export interface EmbedJobResult {
  embedded: number;
  errors: number;
}

export interface IndexJobResult {
  sync: SyncResult;
  embed: EmbedJobResult;
}

export type JobResult =
  | { kind: "sync"; value: SyncResult }
  | { kind: "embed"; value: EmbedJobResult }
  | { kind: "index"; value: IndexJobResult };

export interface JobRecord {
  id: string;
  type: JobType;
  status: JobStatus;
  startedAt: number;
  completedAt?: number;
  /** @deprecated Use typedResult for new job types */
  result?: SyncResult;
  typedResult?: JobResult;
  error?: string;
  progress?: { current: number; total: number; currentFile?: string };
  /** Reindex jobs: the collection (null = all) and merged paths (null = whole). */
  scope?: { collection: string | null; paths: string[] | null };
  serverInstanceId: string;
}

export interface ReindexOptions {
  gitPull: boolean;
  runUpdateCmd: boolean;
}

/** What one reindex pass covers; `paths` null means the whole collection. */
export interface ReindexScope {
  collection: string | null;
  paths: string[] | null;
  options: ReindexOptions;
}

/**
 * A reindex request. `run` must honour the scope it is given: when requests
 * merge, the pass runs the latest request's `run` over the merged scope.
 */
export interface ReindexRequest {
  type: "sync" | "index";
  collection: string | null;
  paths: string[] | null;
  options: ReindexOptions;
  run: (scope: ReindexScope, signal: AbortSignal) => Promise<JobResult>;
}

export interface ReindexAccepted {
  jobId: string;
  status: "running" | "queued";
}

interface PendingReindex {
  job: JobRecord;
  type: ReindexRequest["type"];
  collection: string | null;
  paths: Set<string> | null;
  /** null while only path requests joined: options come from a whole request. */
  options: ReindexOptions | null;
  run: ReindexRequest["run"];
}

const NO_REINDEX_OPTIONS: ReindexOptions = {
  gitPull: false,
  runUpdateCmd: false,
};

export interface JobManagerOptions {
  lockPath: string;
  serverInstanceId: string;
  toolMutex: {
    acquire: () => Promise<() => void>;
  };
  lockTimeoutMs?: number;
}

export type JobErrorCode = "LOCKED" | "JOB_CONFLICT" | "QUEUE_FULL";

export class JobError extends Error {
  code: JobErrorCode;

  constructor(code: JobErrorCode, message: string) {
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
  #jobAuthorizationEpochs = new Map<string, string>();
  #activeJobs = new Set<Promise<void>>();
  #jobControllers = new Map<string, AbortController>();
  #authorizationEpoch = "egress-epoch-uninitialized";
  #accepting = true;
  #releaseJobLocks = new Map<string, () => Promise<void>>();
  /** Pending reindex jobs in arrival order. */
  #pending: PendingReindex[] = [];
  /** Context captured at construction; queued jobs start here, not in the previous job's. */
  #rootContext = AsyncLocalStorage.snapshot();

  constructor(options: JobManagerOptions) {
    this.#lockPath = options.lockPath;
    this.#serverInstanceId = options.serverInstanceId;
    this.#toolMutex = options.toolMutex;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  }

  async startJob(
    type: JobType,
    fn: (signal: AbortSignal) => Promise<SyncResult>
  ): Promise<string> {
    assertInferenceActive();
    this.#assertAccepting();
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

    if (!this.#accepting) {
      await lock.release();
      this.#assertAccepting();
    }

    return this.#startJobWithLock(type, fn, lock);
  }

  async startJobWithLock(
    type: JobType,
    lock: WriteLockHandle,
    fn: (signal: AbortSignal) => Promise<SyncResult>
  ): Promise<string> {
    assertInferenceActive();
    this.#assertAccepting();
    this.#cleanupExpiredJobs();

    if (this.#activeJobId) {
      throw new JobError(
        "JOB_CONFLICT",
        `${MCP_ERRORS.JOB_CONFLICT.message} (${this.#activeJobId})`
      );
    }

    return this.#startJobWithLock(type, fn, lock);
  }

  /**
   * Start a job with typed result (for embed/index jobs).
   * Uses discriminated union for type-safe results.
   */
  async startTypedJobWithLock(
    type: JobType,
    lock: WriteLockHandle,
    fn: (signal: AbortSignal) => Promise<JobResult>
  ): Promise<string> {
    assertInferenceActive();
    this.#assertAccepting();
    this.#cleanupExpiredJobs();

    if (this.#activeJobId) {
      throw new JobError(
        "JOB_CONFLICT",
        `${MCP_ERRORS.JOB_CONFLICT.message} (${this.#activeJobId})`
      );
    }

    return this.#startTypedJobWithLock(type, fn, lock);
  }

  /**
   * Start a reindex now when nothing else is running or waiting; otherwise
   * queue it. A request joins a waiting job for the same type and collection
   * when that cannot change what the job is allowed to do: a path request
   * joins any of them, and a whole-collection request joins a path-only job
   * (setting its options) or a whole job with the same options. Joined
   * requests share one job id, so any number of them cause at most one more
   * pass. Throws `LOCKED` when another process holds the write lease at an
   * immediate start, and `QUEUE_FULL` at the pending bound.
   */
  async submitReindex(request: ReindexRequest): Promise<ReindexAccepted> {
    assertInferenceActive();
    this.#assertAccepting();
    this.#cleanupExpiredJobs();

    // Only join work accepted under the current egress policy: a stale entry
    // fails at admission and must not swallow a freshly authorized request.
    const pending = this.#pending.find(
      (entry) =>
        joins(entry, request) &&
        this.#jobAuthorizationEpochs.get(entry.job.id) ===
          this.#authorizationEpoch
    );
    if (pending) {
      if (request.paths === null) {
        pending.paths = null;
        pending.options = request.options;
      } else if (pending.paths) {
        for (const path of request.paths) pending.paths.add(path);
        // Too many files for one path pass: rescan the collection instead,
        // with no git pull or update command, which no path request asked for.
        if (pending.paths.size > MAX_REINDEX_PATHS) {
          pending.paths = null;
          pending.options = { gitPull: false, runUpdateCmd: false };
        }
      }
      pending.run = request.run;
      pending.job.scope = scopeRecord(pending.collection, pending.paths);
      return { jobId: pending.job.id, status: "queued" };
    }

    if (!this.#activeJobId && this.#pending.length === 0) {
      const job = this.#newJob(request.type, "running");
      job.scope = scopeRecord(request.collection, request.paths);
      this.#activeJobId = job.id;
      const lock = await acquireWriteLock(this.#lockPath, this.#lockTimeoutMs);
      if (!lock || !this.#accepting) {
        await lock?.release();
        this.#jobs.delete(job.id);
        this.#jobAuthorizationEpochs.delete(job.id);
        this.#activeJobId = null;
        this.#track(this.#drainPending());
        this.#assertAccepting();
        throw new JobError("LOCKED", MCP_ERRORS.LOCKED.message);
      }
      const scope: ReindexScope = {
        collection: request.collection,
        paths: request.paths,
        options: request.options,
      };
      this.#launchTyped(job, (signal) => request.run(scope, signal), lock);
      return { jobId: job.id, status: "running" };
    }

    if (this.#pending.length >= MAX_PENDING_REINDEX_JOBS) {
      throw new JobError(
        "QUEUE_FULL",
        `${MCP_ERRORS.QUEUE_FULL.message} (${MAX_PENDING_REINDEX_JOBS} waiting)`
      );
    }
    const job = this.#newJob(request.type, "queued");
    job.scope = scopeRecord(request.collection, request.paths);
    this.#pending.push({
      job,
      type: request.type,
      collection: request.collection,
      paths: request.paths ? new Set(request.paths) : null,
      options: request.paths ? null : request.options,
      run: request.run,
    });
    return { jobId: job.id, status: "queued" };
  }

  getJob(jobId: string): JobRecord | undefined {
    this.#cleanupExpiredJobs();
    return this.#jobs.get(jobId);
  }

  getActiveJob(): JobRecord | null {
    if (!this.#activeJobId) return null;
    return this.#jobs.get(this.#activeJobId) ?? null;
  }

  /**
   * Rotate the authorization snapshot used by queued work. Jobs re-check this
   * after acquiring the shared tool mutex, immediately before any work runs.
   */
  setAuthorizationEpoch(epoch: string): number {
    if (epoch === this.#authorizationEpoch) return 0;
    this.#authorizationEpoch = epoch;
    let invalidated = 0;
    for (const job of this.#jobs.values()) {
      if (
        (job.status === "running" || job.status === "queued") &&
        this.#jobAuthorizationEpochs.get(job.id) !== epoch
      ) {
        invalidated += 1;
      }
    }
    return invalidated;
  }

  updateJobProgress(
    jobId: string,
    progress: { current: number; total: number; currentFile?: string }
  ): void {
    const job = this.#jobs.get(jobId);
    if (job) job.progress = progress;
  }

  clear(): void {
    this.#pending = [];
    this.#jobs.clear();
    this.#jobAuthorizationEpochs.clear();
    this.#activeJobId = null;
  }

  listJobs(limit: number = 10): { active: JobRecord[]; recent: JobRecord[] } {
    this.#cleanupExpiredJobs();

    const jobs = Array.from(this.#jobs.values());
    const active = jobs
      .filter((job) => isUnfinished(job))
      .sort((a, b) => a.startedAt - b.startedAt);

    const recent = jobs
      .filter((job) => !isUnfinished(job))
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
      .slice(0, limit);

    return { active, recent };
  }

  /** Internal owner control; cancellation retains the existing failed job schema. */
  cancelJob(jobId: string): boolean {
    const controller = this.#jobControllers.get(jobId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async shutdown(): Promise<void> {
    this.stop();
    await Promise.allSettled(this.#activeJobs);
  }

  stop(): void {
    this.#accepting = false;
    for (const { job } of this.#pending)
      failJob(job, "Resident runtime is shutting down");
    this.#pending = [];
  }

  cancel(): void {
    this.stop();
    for (const controller of this.#jobControllers.values()) controller.abort();
  }

  /** Call only after the shared shutdown budget; late callbacks stay canceled. */
  async failUnfinished(): Promise<void> {
    this.cancel();
    for (const job of this.#jobs.values()) {
      if (job.status !== "running") continue;
      job.status = "failed";
      job.error = "Resident shutdown deadline exceeded";
      job.completedAt = Date.now();
    }
    await Promise.allSettled(
      Array.from(this.#releaseJobLocks.values(), (release) => release())
    );
  }

  #assertAccepting(): void {
    if (!this.#accepting) throw new Error("Resident runtime is shutting down");
  }

  #ownLock(jobId: string, lock: WriteLockHandle): WriteLockHandle {
    let releasing: Promise<void> | undefined;
    const owned = {
      release: () =>
        (releasing ??= Promise.resolve().then(() => lock.release())),
    };
    this.#releaseJobLocks.set(jobId, owned.release);
    return owned;
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
    fn: (signal: AbortSignal) => Promise<SyncResult>,
    lock: { release: () => Promise<void> }
  ): Promise<void> {
    try {
      await this.#admit(job);
      assertInferenceActive();
      const result = await fn(this.#jobControllers.get(job.id)!.signal);
      assertInferenceActive();
      job.status = "completed";
      job.result = result;
    } catch (e) {
      job.status = "failed";
      job.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.#releaseJobLocks.delete(job.id);
      this.#jobControllers.delete(job.id);
      job.completedAt = Date.now();
      this.#activeJobId = null;
      await lock.release().catch(() => undefined);
      this.#cleanupExpiredJobs();
      await this.#drainPending();
    }
  }

  #startJobWithLock(
    type: JobType,
    fn: (signal: AbortSignal) => Promise<SyncResult>,
    lock: WriteLockHandle
  ): string {
    const jobId = crypto.randomUUID();
    const ownedLock = this.#ownLock(jobId, lock);
    const job: JobRecord = {
      id: jobId,
      type,
      status: "running",
      startedAt: Date.now(),
      serverInstanceId: this.#serverInstanceId,
    };

    this.#jobControllers.set(jobId, new AbortController());
    this.#jobs.set(jobId, job);
    this.#jobAuthorizationEpochs.set(jobId, this.#authorizationEpoch);
    this.#activeJobId = jobId;

    const jobPromise = withOwnedInferenceScope(
      { signal: this.#jobControllers.get(jobId)!.signal },
      () => withBackgroundInference(() => this.#runJob(job, fn, ownedLock))
    );
    this.#track(jobPromise);

    return jobId;
  }

  #startTypedJobWithLock(
    type: JobType,
    fn: (signal: AbortSignal) => Promise<JobResult>,
    lock: WriteLockHandle
  ): string {
    const job = this.#newJob(type, "running");
    this.#launchTyped(job, fn, lock);
    return job.id;
  }

  /** Record a job and the authorization epoch it was accepted under. */
  #newJob(type: JobType, status: "queued" | "running"): JobRecord {
    const job: JobRecord = {
      id: crypto.randomUUID(),
      type,
      status,
      startedAt: Date.now(),
      serverInstanceId: this.#serverInstanceId,
    };
    this.#jobs.set(job.id, job);
    this.#jobAuthorizationEpochs.set(job.id, this.#authorizationEpoch);
    return job;
  }

  #launchTyped(
    job: JobRecord,
    fn: (signal: AbortSignal) => Promise<JobResult>,
    lock: WriteLockHandle
  ): void {
    const ownedLock = this.#ownLock(job.id, lock);
    const controller = new AbortController();
    job.status = "running";
    job.startedAt = Date.now();
    this.#jobControllers.set(job.id, controller);
    this.#activeJobId = job.id;

    const jobPromise = withOwnedInferenceScope(
      { signal: controller.signal },
      () => withBackgroundInference(() => this.#runTypedJob(job, fn, ownedLock))
    );
    this.#track(jobPromise);
  }

  /** Start waiting reindex jobs, in arrival order, while nothing is running. */
  async #drainPending(): Promise<void> {
    while (!this.#activeJobId) {
      const entry = this.#pending.shift();
      if (!entry) return;
      this.#activeJobId = entry.job.id;
      const lock = await acquireWriteLock(this.#lockPath, this.#lockTimeoutMs);
      if (!lock || !this.#accepting) {
        await lock?.release();
        this.#activeJobId = null;
        failJob(
          entry.job,
          this.#accepting
            ? `${MCP_ERRORS.LOCKED.code}: ${MCP_ERRORS.LOCKED.message}`
            : "Resident runtime is shutting down"
        );
        continue;
      }
      const scope: ReindexScope = {
        collection: entry.collection,
        paths: entry.paths ? [...entry.paths].sort() : null,
        options: entry.options ?? NO_REINDEX_OPTIONS,
      };
      this.#rootContext(() =>
        this.#launchTyped(entry.job, (signal) => entry.run(scope, signal), lock)
      );
    }
  }

  async #runTypedJob(
    job: JobRecord,
    fn: (signal: AbortSignal) => Promise<JobResult>,
    lock: { release: () => Promise<void> }
  ): Promise<void> {
    try {
      await this.#admit(job);
      assertInferenceActive();
      const result = await fn(this.#jobControllers.get(job.id)!.signal);
      assertInferenceActive();
      job.status = "completed";
      job.typedResult = result;
      if (result.kind === "sync") job.result = result.value;
    } catch (e) {
      job.status = "failed";
      job.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.#releaseJobLocks.delete(job.id);
      this.#jobControllers.delete(job.id);
      job.completedAt = Date.now();
      this.#activeJobId = null;
      await lock.release().catch(() => undefined);
      this.#cleanupExpiredJobs();
      await this.#drainPending();
    }
  }

  #cleanupExpiredJobs(now: number = Date.now()): void {
    for (const [id, job] of this.#jobs) {
      if (isUnfinished(job)) {
        continue;
      }
      const completedAt = job.completedAt ?? job.startedAt;
      if (now - completedAt > JOB_EXPIRATION_MS) {
        this.#jobs.delete(id);
        this.#jobAuthorizationEpochs.delete(id);
      }
    }

    const completed = Array.from(this.#jobs.values())
      .filter((job) => !isUnfinished(job))
      .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));

    if (completed.length <= JOB_MAX_RECENT) {
      return;
    }

    const toRemove = completed.length - JOB_MAX_RECENT;
    for (let i = 0; i < toRemove; i++) {
      const job = completed[i];
      if (job) {
        this.#jobs.delete(job.id);
        this.#jobAuthorizationEpochs.delete(job.id);
      }
    }
  }

  /**
   * Wait for the tool call in progress, then re-check authorization. The
   * mutex is released before the job's work runs, so reads are not held
   * behind a long sync or embed; writers stay serialized by the write lease.
   */
  async #admit(job: JobRecord): Promise<void> {
    const release = await this.#toolMutex.acquire();
    try {
      this.#assertAuthorizationEpoch(job);
    } finally {
      release();
    }
  }

  #assertAuthorizationEpoch(job: JobRecord): void {
    if (this.#jobAuthorizationEpochs.get(job.id) === this.#authorizationEpoch) {
      return;
    }
    throw new Error(
      "STALE_EGRESS_POLICY: collection policy changed; retry to re-authorize"
    );
  }
}

function joins(entry: PendingReindex, request: ReindexRequest): boolean {
  if (entry.type !== request.type || entry.collection !== request.collection)
    return false;
  if (request.paths !== null) return true;
  if (entry.options === null) return true;
  return (
    entry.paths === null &&
    entry.options.gitPull === request.options.gitPull &&
    entry.options.runUpdateCmd === request.options.runUpdateCmd
  );
}

function scopeRecord(
  collection: string | null,
  paths: Iterable<string> | null
): NonNullable<JobRecord["scope"]> {
  return { collection, paths: paths ? [...paths].sort() : null };
}

const isUnfinished = (job: JobRecord): boolean =>
  job.status === "running" || job.status === "queued";

function failJob(job: JobRecord, error: string): void {
  job.status = "failed";
  job.error = error;
  job.completedAt = Date.now();
}
