/**
 * Per-file indexing budget: the terminable file worker (fn-198).
 *
 * Everything CPU-bound between a file's bytes and its database write
 * (`prepareFile`: conversion, metadata, code regions, change-journal
 * structure, chunking, link parsing) runs in one worker, one file at a time.
 * The main thread stops the worker the moment a file runs past its
 * wall-clock budget or the process's resident memory passes the memory
 * budget, mid-step if need be; the file fails with TIMEOUT or MEMORY_LIMIT,
 * the worker is replaced, and the run continues with the next file.
 *
 * One worker is reused across files (starting one costs about a third of a
 * second of module loading). It is replaced after an overrun, after a file
 * that leaves resident memory above half the budget, and after a short idle
 * period. A standalone compiled executable cannot start a TypeScript worker
 * entry; sync then prepares files in-process and checks the budget between
 * steps. npm and desktop installs run source and use the worker.
 *
 * @module src/ingestion/file-worker
 */

// node:os totalmem: Bun has no API for physical memory size.
import { totalmem } from "node:os";

import type { DocumentStructureSnapshot } from "../core/change-diff";
import type {
  PrepareFailure,
  PrepareFileRequest,
  PrepareOutcome,
} from "./prepare-file";

import { isBunfsPath } from "../serve/spa-production-build";
import { PREPARE_PHASES } from "./prepare-file";

/** Resource budget for indexing one file. */
export interface FileBudgetLimits {
  /** Wall-clock budget in milliseconds (`conversion.timeoutMs`). */
  timeoutMs: number;
  /** Process resident-memory ceiling in bytes (`conversion.maxMemoryMb`). */
  maxMemoryBytes: number;
}

/** One file for the worker, with the shared slot it records its step in. */
export interface FileWorkerRequest {
  request: PrepareFileRequest;
  /** Index into PREPARE_PHASES of the running step; -1 before the first. */
  phaseSlot: Int32Array;
}

/** Messages the worker posts while it prepares one file. */
export type FileWorkerMessage =
  | { type: "previous"; structure: DocumentStructureSnapshot }
  | { type: "done"; outcome: PrepareOutcome };

export interface FileWorkerHooks {
  onPrevious: (structure: DocumentStructureSnapshot) => void;
}

/** Error codes of a file stopped at its budget. */
export const BUDGET_ERROR_CODES: ReadonlySet<string> = new Set([
  "TIMEOUT",
  "MEMORY_LIMIT",
]);

/** How often resident memory is sampled while the worker runs. */
const MEMORY_SAMPLE_INTERVAL_MS = 200;
/** An idle worker is stopped so a long-running process does not hold it. */
const WORKER_IDLE_MS = 30_000;
const BYTES_PER_MB = 1_048_576;
/** Floor for the default memory budget on small machines. */
const MIN_DEFAULT_MEMORY_MB = 2048;

/**
 * Default resident-memory budget in MB: half of physical memory, at least
 * 2 GB. `conversion.maxMemoryMb` overrides it.
 */
export function defaultConversionMemoryMb(): number {
  return Math.max(
    MIN_DEFAULT_MEMORY_MB,
    Math.floor(totalmem() / 2 / BYTES_PER_MB)
  );
}

/** Budget failure for elapsed time, reported against the running step. */
export function timeoutFailure(
  phase: string,
  elapsedMs: number,
  timeoutMs: number
): PrepareFailure {
  return {
    code: "TIMEOUT",
    message: `Indexing stopped during ${phase}: ${Math.round(elapsedMs)}ms exceeded the ${timeoutMs}ms budget`,
    details: { phase, elapsedMs: Math.round(elapsedMs), timeoutMs },
  };
}

/** Budget failure for process resident memory. */
export function memoryFailure(
  phase: string,
  rssBytes: number,
  maxMemoryBytes: number
): PrepareFailure {
  const rssMb = Math.round(rssBytes / BYTES_PER_MB);
  const maxMemoryMb = Math.round(maxMemoryBytes / BYTES_PER_MB);
  return {
    code: "MEMORY_LIMIT",
    message: `Indexing stopped during ${phase}: resident memory ${rssMb} MB exceeded the ${maxMemoryMb} MB budget`,
    details: { phase, rssMb, maxMemoryMb },
  };
}

/** Whether this runtime can start the TypeScript worker entry. */
export function canUseFileWorker(): boolean {
  return !isBunfsPath(import.meta.path);
}

let worker: Worker | null = null;
/** Shared with the worker: the step it is running, for overrun messages. */
const phaseSlot = new Int32Array(new SharedArrayBuffer(4));
let workersStarted = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let queue: Promise<unknown> = Promise.resolve();

/** Number of file workers started in this process (for tests). */
export function fileWorkersStarted(): number {
  return workersStarted;
}

const stopWorker = (): void => {
  clearTimeout(idleTimer);
  worker?.terminate();
  worker = null;
};

const acquireWorker = (): Worker => {
  clearTimeout(idleTimer);
  if (!worker) {
    worker = new Worker(new URL("./prepare-worker.ts", import.meta.url));
    workersStarted += 1;
    // An idle worker must never keep a CLI process alive. Bun's Worker has
    // unref(); the DOM lib type in this tsconfig does not declare it.
    (worker as Worker & { unref(): void }).unref();
  }
  return worker;
};

const runInWorker = (
  request: PrepareFileRequest,
  budget: FileBudgetLimits,
  hooks: FileWorkerHooks
): Promise<PrepareOutcome> => {
  const active = acquireWorker();
  const startedAt = performance.now();
  Atomics.store(phaseSlot, 0, -1);
  const phase = (): string =>
    PREPARE_PHASES[Atomics.load(phaseSlot, 0)] ?? "startup";
  return new Promise<PrepareOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: PrepareOutcome, keepWorker: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearInterval(sampler);
      active.onmessage = null;
      active.onerror = null;
      if (
        keepWorker &&
        process.memoryUsage.rss() <= budget.maxMemoryBytes / 2
      ) {
        idleTimer = setTimeout(stopWorker, WORKER_IDLE_MS);
        idleTimer.unref?.();
      } else {
        stopWorker();
      }
      resolve(outcome);
    };
    const deadline = setTimeout(() => {
      finish(
        {
          ok: false,
          error: timeoutFailure(
            phase(),
            performance.now() - startedAt,
            budget.timeoutMs
          ),
        },
        false
      );
    }, budget.timeoutMs);
    const checkMemory = (): void => {
      const rss = process.memoryUsage.rss();
      if (rss > budget.maxMemoryBytes) {
        finish(
          {
            ok: false,
            error: memoryFailure(phase(), rss, budget.maxMemoryBytes),
          },
          false
        );
      }
    };
    const sampler = setInterval(checkMemory, MEMORY_SAMPLE_INTERVAL_MS);
    active.onmessage = (event: MessageEvent<FileWorkerMessage>) => {
      const message = event.data;
      if (message.type === "previous") hooks.onPrevious(message.structure);
      else finish(message.outcome, true);
    };
    active.onerror = (event: ErrorEvent) => {
      finish(
        {
          ok: false,
          error: {
            code: "INTERNAL",
            message: event.message || "File worker failed",
          },
        },
        false
      );
    };
    // A process already over the budget does not start another file.
    checkMemory();
    if (!settled) {
      const job: FileWorkerRequest = { request, phaseSlot };
      active.postMessage(job);
    }
  });
};

/**
 * Prepare one file in the file worker under its time and memory budget.
 * Files run one at a time; the budget clock starts when a file reaches the
 * worker, not while it queues.
 */
export function prepareInWorker(
  request: PrepareFileRequest,
  budget: FileBudgetLimits,
  hooks: FileWorkerHooks
): Promise<PrepareOutcome> {
  const result = queue.then(() => runInWorker(request, budget, hooks));
  queue = result.catch(() => undefined);
  return result;
}
