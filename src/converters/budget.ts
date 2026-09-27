/**
 * Per-file conversion budget (fn-198).
 *
 * Converters for binary formats (PDF, DOCX, XLSX, PPTX) do most of their work
 * synchronously, so an in-process timer can never interrupt them: a large
 * spreadsheet could hold the event loop for hours. Budgeted conversion runs
 * them in a worker and terminates it when the file exceeds its wall-clock
 * budget or the process's resident memory passes the memory budget. The file
 * then fails with TIMEOUT or MEMORY_LIMIT and the run continues.
 *
 * One worker is reused for successive conversions (starting one costs about
 * a third of a second of module loading) and handles one file at a time; the
 * budget clock starts when a file reaches the worker, not while it queues.
 * The worker is replaced after an overrun, after a conversion that leaves
 * resident memory above half the budget, and after a short idle period.
 *
 * Native Markdown and plain-text conversion is linear and stays in-process.
 * A standalone compiled executable cannot start a TypeScript worker entry and
 * also converts in-process (no budget); npm and desktop installs run source.
 *
 * @module src/converters/budget
 */

// node:os totalmem: Bun has no API for physical memory size.
import { totalmem } from "node:os";

import type { ConvertError, ConvertInput, PipelineResult } from "./types";

import { isBunfsPath } from "../serve/spa-production-build";
import { convertError, internalError, timeoutError } from "./errors";

/** Resource budget for converting one file. */
export interface ConversionBudget {
  /** Wall-clock budget in milliseconds (the conversion `timeoutMs`). */
  timeoutMs: number;
  /** Process resident-memory ceiling in bytes while the file converts. */
  maxMemoryBytes: number;
}

/** Error codes of a file stopped at its conversion budget. */
export const BUDGET_ERROR_CODES: ReadonlySet<string> = new Set([
  "TIMEOUT",
  "MEMORY_LIMIT",
]);

/** How often resident memory is sampled while a worker converts. */
const MEMORY_SAMPLE_INTERVAL_MS = 200;
/** An idle worker is stopped so a long-running process does not hold it. */
const WORKER_IDLE_MS = 30_000;

const BUDGET_CONVERTER_ID = "budget";
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

/** Error for a conversion stopped at the memory budget. */
export function memoryLimitError(
  input: Pick<ConvertInput, "sourcePath" | "mime" | "ext">,
  maxMemoryBytes: number,
  rssBytes: number
): ConvertError {
  const limitMb = Math.round(maxMemoryBytes / BYTES_PER_MB);
  const rssMb = Math.round(rssBytes / BYTES_PER_MB);
  return convertError("MEMORY_LIMIT", {
    message: `Conversion stopped: resident memory ${rssMb} MB exceeded the ${limitMb} MB budget`,
    retryable: true,
    fatal: false,
    converterId: BUDGET_CONVERTER_ID,
    sourcePath: input.sourcePath,
    mime: input.mime,
    ext: input.ext,
    details: { maxMemoryMb: limitMb, rssMb },
  });
}

/** Whether this runtime can start the TypeScript worker entry. */
export function canIsolateConversion(): boolean {
  return !isBunfsPath(import.meta.path);
}

let worker: Worker | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let queue: Promise<unknown> = Promise.resolve();

const stopWorker = (): void => {
  clearTimeout(idleTimer);
  worker?.terminate();
  worker = null;
};

const acquireWorker = (): Worker => {
  clearTimeout(idleTimer);
  if (!worker) {
    worker = new Worker(new URL("./convert-worker.ts", import.meta.url));
    // An idle worker must never keep a CLI process alive. Bun's Worker has
    // unref(); the DOM lib type in this tsconfig does not declare it.
    (worker as Worker & { unref(): void }).unref();
  }
  return worker;
};

const runInWorker = (
  input: ConvertInput,
  budget: ConversionBudget
): Promise<PipelineResult> => {
  const active = acquireWorker();
  return new Promise<PipelineResult>((resolve) => {
    let settled = false;
    const finish = (result: PipelineResult, keepWorker: boolean): void => {
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
      resolve(result);
    };
    const deadline = setTimeout(() => {
      finish(
        {
          ok: false,
          error: timeoutError(
            {
              ...input,
              limits: { ...input.limits, timeoutMs: budget.timeoutMs },
            },
            BUDGET_CONVERTER_ID
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
            error: memoryLimitError(input, budget.maxMemoryBytes, rss),
          },
          false
        );
      }
    };
    const sampler = setInterval(checkMemory, MEMORY_SAMPLE_INTERVAL_MS);
    active.onmessage = (event: MessageEvent<PipelineResult>) => {
      finish(event.data, true);
    };
    active.onerror = (event: ErrorEvent) => {
      finish(
        {
          ok: false,
          error: internalError(
            input,
            BUDGET_CONVERTER_ID,
            event.message || "Conversion worker failed"
          ),
        },
        false
      );
    };
    // A process already over the budget does not start another conversion.
    checkMemory();
    if (!settled) active.postMessage(input);
  });
};

/**
 * Convert one file in the conversion worker under a time and memory budget.
 * Resolves with the pipeline result, or TIMEOUT / MEMORY_LIMIT when the file
 * overran and its worker was stopped. Files convert one at a time.
 */
export function convertInWorker(
  input: ConvertInput,
  budget: ConversionBudget
): Promise<PipelineResult> {
  const result = queue.then(() => runInWorker(input, budget));
  queue = result.catch(() => undefined);
  return result;
}
