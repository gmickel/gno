/**
 * Per-file indexing budget: the terminable file processor (fn-198).
 *
 * Everything CPU-bound between a file's bytes and its database write
 * (`prepareFile`: conversion, metadata, code regions, change-journal
 * structure, chunking, link parsing) runs outside the main thread, one file
 * at a time. The main thread stops it the moment a file runs past its
 * wall-clock budget or resident memory passes the memory budget, mid-step
 * if need be; the file fails with TIMEOUT or MEMORY_LIMIT, the processor is
 * replaced, and the run continues with the next file.
 *
 * Two backends share that contract:
 * - worker: a Bun Worker (source runtimes: npm and desktop installs);
 * - child: a child process of the same executable (standalone compiled
 *   executables, which cannot start a TypeScript worker entry), talking
 *   over IPC. Its memory is the parent's plus the child's resident set,
 *   sampled from /proc on Linux and `ps` elsewhere; on Windows the child
 *   backend enforces the time budget only.
 * If no backend can start, the file fails closed with
 * ISOLATION_UNAVAILABLE; it is never prepared unbounded.
 *
 * One processor is reused across files (starting one costs about a third of
 * a second of module loading). It is replaced after an overrun, after a
 * file that leaves memory above half the budget, and after a short idle
 * period, and never keeps a process alive on its own.
 *
 * @module src/ingestion/file-processor
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
import { FILE_PROCESSOR_CHILD_ENV } from "./file-child-env";
import { PREPARE_PHASES } from "./prepare-file";

/** Resource budget for indexing one file. */
export interface FileBudgetLimits {
  /** Wall-clock budget in milliseconds (`conversion.timeoutMs`). */
  timeoutMs: number;
  /** Resident-memory ceiling in bytes (`conversion.maxMemoryMb`). */
  maxMemoryBytes: number;
}

/** One file for the worker, with the shared slot it records its step in. */
export interface FileWorkerRequest {
  request: PrepareFileRequest;
  /** Index into PREPARE_PHASES of the running step; -1 before the first. */
  phaseSlot: Int32Array;
}

/** Messages the processor posts while it prepares one file. */
export type FileWorkerMessage =
  | { type: "previous"; structure: DocumentStructureSnapshot }
  | { type: "done"; outcome: PrepareOutcome };

/** Child messages add the running step (no shared memory across processes). */
export type FileChildMessage =
  | FileWorkerMessage
  | { type: "phase"; phase: string };

export interface FileProcessorHooks {
  onPrevious: (structure: DocumentStructureSnapshot) => void;
  /** Called when the processor starts on the file (its clock starts). */
  onStarted?: () => void;
}

/** Posted once by a processor when it has loaded. */
export interface ReadyMessage {
  type: "ready";
}

export type FileProcessorBackendKind = "worker" | "child";

/** Error codes of a file stopped at its budget. */
export const BUDGET_ERROR_CODES: ReadonlySet<string> = new Set([
  "TIMEOUT",
  "MEMORY_LIMIT",
]);

/** How often resident memory is sampled while a file is processed. */
const MEMORY_SAMPLE_INTERVAL_MS = 200;
/** An idle processor is stopped so a long-running process does not hold it. */
const PROCESSOR_IDLE_MS = 30_000;
const BYTES_PER_MB = 1_048_576;
const BYTES_PER_KB = 1024;
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

/** Budget failure for resident memory. */
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

const unavailableFailure = (reason: string): PrepareFailure => ({
  code: "ISOLATION_UNAVAILABLE",
  message: `Could not start the file processor, so the file was not indexed without its budget: ${reason}`,
});

// ─────────────────────────────────────────────────────────────────────────────
// Backends
// ─────────────────────────────────────────────────────────────────────────────

/** A started processor that prepares one file at a time. */
interface Processor {
  readonly kind: FileProcessorBackendKind;
  /** Settles once the processor has loaded and can take a file. */
  readonly ready: Promise<void>;
  /** Settles, with a reason, if the processor dies or errors. */
  readonly failed: Promise<string>;
  /** Send one file; its messages go to `onMessage`. */
  run(
    request: PrepareFileRequest,
    onMessage: (message: FileWorkerMessage) => void
  ): void;
  /** Name of the running step, for overrun messages. */
  phase(): string;
  /** Resident bytes of this processor outside the main process. */
  externalRss(): Promise<number>;
  /** False once the processor died on its own; it is then replaced. */
  alive(): boolean;
  /** Child process id (child backend), for shutdown and tests. */
  readonly pid: number | null;
  stop(): void;
}

const phaseName = (index: number): string => PREPARE_PHASES[index] ?? "startup";

function startWorker(): Processor {
  const worker = new Worker(new URL("./prepare-worker.ts", import.meta.url));
  // An idle worker must never keep a CLI process alive. Bun's Worker has
  // unref(); the DOM lib type in this tsconfig does not declare it.
  (worker as Worker & { unref(): void }).unref();
  const phaseSlot = new Int32Array(new SharedArrayBuffer(4));
  let onMessage: ((message: FileWorkerMessage) => void) | null = null;
  let markReady: () => void = () => undefined;
  let markFailed: (reason: string) => void = () => undefined;
  let dead = false;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const failed = new Promise<string>((resolve) => {
    markFailed = (reason) => {
      dead = true;
      resolve(reason);
    };
  });
  worker.onmessage = (
    event: MessageEvent<FileWorkerMessage | ReadyMessage>
  ) => {
    if (event.data.type === "ready") markReady();
    else onMessage?.(event.data);
  };
  worker.onerror = (event: ErrorEvent) => {
    markFailed(event.message || "file worker failed");
  };
  return {
    kind: "worker",
    ready,
    failed,
    run(request, messageHandler) {
      Atomics.store(phaseSlot, 0, -1);
      onMessage = messageHandler;
      const job: FileWorkerRequest = { request, phaseSlot };
      worker.postMessage(job);
    },
    phase: () => phaseName(Atomics.load(phaseSlot, 0)),
    externalRss: () => Promise.resolve(0),
    alive: () => !dead,
    pid: null,
    stop() {
      worker.terminate();
      markFailed("file processor was stopped");
    },
  };
}

/** Resident set of another process, in bytes (0 when unknown). */
async function processRss(pid: number): Promise<number> {
  try {
    if (process.platform === "linux") {
      const status = await Bun.file(`/proc/${pid}/status`).text();
      const kb = /^VmRSS:\s+(\d+)/m.exec(status)?.[1];
      return kb ? Number(kb) * BYTES_PER_KB : 0;
    }
    if (process.platform === "win32") return 0;
    const ps = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const kb = Number((await new Response(ps.stdout).text()).trim());
    return Number.isFinite(kb) ? kb * BYTES_PER_KB : 0;
  } catch {
    return 0;
  }
}

function startChild(): Processor {
  const compiled = isBunfsPath(import.meta.path);
  let phase = "startup";
  let onMessage: ((message: FileWorkerMessage) => void) | null = null;
  let markReady: () => void = () => undefined;
  let stopping = false;
  let exited = false;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const child = Bun.spawn({
    // A compiled executable re-runs itself in child mode (src/index.ts); a
    // source runtime runs the child module directly.
    cmd: compiled
      ? [process.execPath]
      : [process.execPath, `${import.meta.dir}/file-child.ts`],
    env: { ...process.env, [FILE_PROCESSOR_CHILD_ENV]: "1" },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "inherit",
    serialization: "advanced",
    ipc(message: FileChildMessage | ReadyMessage) {
      if (message.type === "ready") markReady();
      else if (message.type === "phase") phase = message.phase;
      else onMessage?.(message);
    },
  });
  child.unref();
  liveChildren.add(child);
  ensureShutdownHooks();
  const failed = child.exited.then((code) => {
    exited = true;
    liveChildren.delete(child);
    return stopping
      ? "file processor was stopped"
      : `file processor child exited (${code})`;
  });
  return {
    kind: "child",
    ready,
    failed,
    run(request, messageHandler) {
      phase = "startup";
      onMessage = messageHandler;
      child.send({ request });
    },
    phase: () => phase,
    externalRss: () => processRss(child.pid),
    alive: () => !exited,
    pid: child.pid,
    stop() {
      stopping = true;
      child.kill(9);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Parent shutdown
// ─────────────────────────────────────────────────────────────────────────────

/** Child processors still running; killed on every parent shutdown path. */
const liveChildren = new Set<ReturnType<typeof Bun.spawn>>();
let shutdownHooksInstalled = false;

/** SIGKILL every child processor (they are disposable). Synchronous. */
function killChildren(): void {
  for (const child of liveChildren) {
    try {
      child.kill(9);
    } catch {
      // Already gone.
    }
  }
  liveChildren.clear();
}

/**
 * A signal the process would otherwise die from by default: kill the
 * children, and when no one else handles the signal, stop listening and
 * re-raise it so the process still ends the default way (same exit status).
 * The listener is prepended, so it runs before any other handler and counts
 * the real owners: a `process.once` handler (serve, daemon) removes itself
 * before it runs, so a listener running after it would see none.
 */
function onTerminatingSignal(signal: "SIGINT" | "SIGTERM"): () => void {
  const listener = (): void => {
    killChildren();
    if (process.listenerCount(signal) === 1) {
      process.off(signal, listener);
      process.kill(process.pid, signal);
    }
  };
  return listener;
}

/**
 * Kill child processors whenever this process ends: on exit (the CLI's
 * SIGINT handler and every normal exit end in process.exit), and on SIGTERM.
 * SIGINT gets its own listener only when nothing else owns it: the CLI
 * treats an extra SIGINT listener as a command that finishes its own
 * teardown, so adding one there would stop Ctrl-C from exiting. An
 * uncaught exception is not intercepted (a listener would keep the process
 * alive); the child's parent-death signal (Linux) or its between-step
 * parent check covers it.
 */
function ensureShutdownHooks(): void {
  if (shutdownHooksInstalled) return;
  shutdownHooksInstalled = true;
  process.on("exit", killChildren);
  process.prependListener("SIGTERM", onTerminatingSignal("SIGTERM"));
  if (process.listenerCount("SIGINT") === 0) {
    process.on("SIGINT", onTerminatingSignal("SIGINT"));
  }
}

/**
 * Stop the file processor and any child process now (resident shutdown).
 * A file being prepared fails; the next file starts a new processor.
 */
export function disposeFileProcessor(): void {
  stopProcessor();
  killChildren();
}

/** Tests only: the running child processor's pid, if any. */
export function activeFileProcessorPid(): number | null {
  return processor?.pid ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Processor lifecycle
// ─────────────────────────────────────────────────────────────────────────────

let forcedBackend: FileProcessorBackendKind | null = null;
let processor: Processor | null = null;
let processorsStarted = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let queue: Promise<unknown> = Promise.resolve();

/** Which backend this runtime uses: the worker unless it cannot start. */
export function fileProcessorBackend(): FileProcessorBackendKind {
  return forcedBackend ?? (isBunfsPath(import.meta.path) ? "child" : "worker");
}

/**
 * Tests only: force a backend (null restores the default). Stops the current
 * processor so the next file starts the chosen one.
 */
export function useFileProcessorBackend(
  kind: FileProcessorBackendKind | null
): void {
  forcedBackend = kind;
  stopProcessor();
}

/** Number of file processors started in this process (for tests). */
export function fileProcessorsStarted(): number {
  return processorsStarted;
}

function stopProcessor(): void {
  clearTimeout(idleTimer);
  processor?.stop();
  processor = null;
}

function acquireProcessor(): Processor {
  clearTimeout(idleTimer);
  const kind = fileProcessorBackend();
  if (processor?.kind !== kind || !processor.alive()) {
    processor?.stop();
    processor = kind === "worker" ? startWorker() : startChild();
    processorsStarted += 1;
  }
  return processor;
}

/** How long a new processor may take to load before the file fails closed. */
const PROCESSOR_START_TIMEOUT_MS = 30_000;

/** Wait for the processor to load: null once ready, else why it did not. */
const awaitReady = (active: Processor): Promise<string | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<string>((resolve) => {
    timer = setTimeout(
      () => resolve(`no response within ${PROCESSOR_START_TIMEOUT_MS} ms`),
      PROCESSOR_START_TIMEOUT_MS
    );
  });
  return Promise.race([
    active.ready.then(() => null),
    active.failed,
    timedOut,
  ]).finally(() => clearTimeout(timer));
};

const runOne = async (
  request: PrepareFileRequest,
  budget: FileBudgetLimits,
  hooks: FileProcessorHooks
): Promise<PrepareOutcome> => {
  let active: Processor;
  try {
    active = acquireProcessor();
  } catch (cause) {
    processor = null;
    return {
      ok: false,
      error: unavailableFailure(
        cause instanceof Error ? cause.message : String(cause)
      ),
    };
  }
  // Loading the processor is not the file's time: its clock starts once the
  // processor can take it.
  const notReady = await awaitReady(active);
  if (notReady) {
    if (processor === active) stopProcessor();
    return { ok: false, error: unavailableFailure(notReady) };
  }
  hooks.onStarted?.();
  const startedAt = performance.now();
  return new Promise<PrepareOutcome>((resolve) => {
    let settled = false;
    let sampling = false;
    const finish = (outcome: PrepareOutcome, keep: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearInterval(sampler);
      if (keep && process.memoryUsage.rss() <= budget.maxMemoryBytes / 2) {
        idleTimer = setTimeout(stopProcessor, PROCESSOR_IDLE_MS);
        idleTimer.unref?.();
      } else if (processor === active) {
        stopProcessor();
      } else {
        active.stop();
      }
      resolve(outcome);
    };
    const deadline = setTimeout(() => {
      finish(
        {
          ok: false,
          error: timeoutFailure(
            active.phase(),
            performance.now() - startedAt,
            budget.timeoutMs
          ),
        },
        false
      );
    }, budget.timeoutMs);
    const checkMemory = async (): Promise<void> => {
      if (sampling || settled) return;
      sampling = true;
      const rss = process.memoryUsage.rss() + (await active.externalRss());
      sampling = false;
      if (rss > budget.maxMemoryBytes) {
        finish(
          {
            ok: false,
            error: memoryFailure(active.phase(), rss, budget.maxMemoryBytes),
          },
          false
        );
      }
    };
    const sampler = setInterval(() => {
      void checkMemory();
    }, MEMORY_SAMPLE_INTERVAL_MS);
    void active.failed.then((reason) =>
      finish({ ok: false, error: { code: "INTERNAL", message: reason } }, false)
    );
    // A process already over the budget does not start another file.
    const rss = process.memoryUsage.rss();
    if (rss > budget.maxMemoryBytes) {
      finish(
        {
          ok: false,
          error: memoryFailure("startup", rss, budget.maxMemoryBytes),
        },
        false
      );
      return;
    }
    active.run(request, (message) => {
      if (message.type === "previous") hooks.onPrevious(message.structure);
      else finish(message.outcome, true);
    });
  });
};

/**
 * Prepare one file in the file processor under its time and memory budget.
 * Files run one at a time; the budget clock starts when a file reaches the
 * processor, not while it queues.
 */
export function prepareInProcessor(
  request: PrepareFileRequest,
  budget: FileBudgetLimits,
  hooks: FileProcessorHooks
): Promise<PrepareOutcome> {
  const result = queue.then(() => runOne(request, budget, hooks));
  queue = result.catch(() => undefined);
  return result;
}
