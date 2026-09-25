/**
 * Debounced embedding scheduler for web UI.
 * Accumulates docIds from sync operations and runs embedding after debounce.
 *
 * @module src/serve/embed-scheduler
 */

import type { Database } from "bun:sqlite";

import type { EmbeddingPort } from "../llm/types";
import type { VectorIndexPort } from "../store/vector";
import type { BackgroundIssue } from "./status-model";

import { embedBacklog } from "../embed";
import {
  withBackgroundInference,
  withOwnedInferenceScope,
} from "../llm/inference-scope";
import { createVectorStatsPort } from "../store/vector";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 30_000; // 30 seconds
const MAX_WAIT_MS = 300_000; // 5 minutes
const BATCH_SIZE = 32;
/** Consecutive failed passes after which automatic retries stop (parked). */
export const MAX_FAILED_PASSES = 5;
/** A pass running longer than this is reported as overrunning. */
export const PASS_OVERRUN_MS = 15 * 60_000;

/** Delay before the automatic retry that follows `failures` failed passes. */
export function failedPassRetryDelayMs(failures: number): number {
  return DEBOUNCE_MS * 2 ** Math.max(0, failures - 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface EmbedSchedulerState {
  pendingDocCount: number;
  running: boolean;
  nextRunAt?: number;
  lastRunAt?: number;
  lastResult?: EmbedResult;
  /** Start of the pass in flight. */
  runningSince?: number;
  /** Failed passes since the last clean pass (0 when healthy). */
  consecutiveFailures: number;
  /** Automatic retries stopped; chunks stay pending for new work or `gno embed`. */
  parked: boolean;
}

export interface EmbedResult {
  embedded: number;
  errors: number;
}

export interface EmbedSchedulerDeps {
  db: Database;
  /** Getter for current embed port (survives context reloads) */
  getEmbedPort: () => EmbeddingPort | null;
  /** Getter for current vector index (survives context reloads) */
  getVectorIndex: () => VectorIndexPort | null;
  /** Getter for current model URI (survives preset changes) */
  getModelUri: () => string;
  onEmbedded?: (result: EmbedResult) => void;
  embedBacklogFn?: typeof embedBacklog;
  /**
   * Shared writer lease for one page of background writes; null when another
   * writer holds it, which defers the rest of the pass instead of waiting.
   */
  acquireWriteLease?: () => Promise<(() => Promise<void>) | null>;
}

/** Project scheduler state onto status issues; empty while healthy. */
export function embedSchedulerIssues(
  state: EmbedSchedulerState,
  now = Date.now()
): BackgroundIssue[] {
  const issues: BackgroundIssue[] = [];
  if (state.parked || state.consecutiveFailures > 0) {
    issues.push({
      job: "embed",
      state: state.parked ? "parked" : "failing",
      consecutiveFailures: state.consecutiveFailures,
      runningSeconds: null,
    });
  }
  if (
    state.runningSince !== undefined &&
    now - state.runningSince > PASS_OVERRUN_MS
  ) {
    issues.push({
      job: "embed",
      state: "overrunning",
      consecutiveFailures: state.consecutiveFailures,
      runningSeconds: Math.floor((now - state.runningSince) / 1000),
    });
  }
  return issues;
}

interface PassOutcome {
  result: EmbedResult;
  /** Present when the pass failed; the message is logged once per retry step. */
  failure?: string;
  /** Another writer held the lease; the rest of the backlog waits for a rerun. */
  deferred?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduler
// ─────────────────────────────────────────────────────────────────────────────

export interface EmbedScheduler {
  /** Called after sync with list of changed doc IDs (docid not id) */
  notifySyncComplete(docIds: string[]): void;

  /** Force immediate embed (for Cmd+S). Returns null if no embedPort. */
  triggerNow(): Promise<EmbedResult | null>;

  /** Get current state (for debugging/status) */
  getState(): EmbedSchedulerState;

  /** Cleanup on server shutdown */
  dispose(): Promise<void>;
  /** Stop new turns while allowing the current pass to settle before cancellation. */
  stop?(): Promise<void>;
}

/**
 * Create an embed scheduler for debounced background embedding.
 * Uses getters to resolve dependencies at execution time (survives context reloads).
 */
export function createEmbedScheduler(deps: EmbedSchedulerDeps): EmbedScheduler {
  const {
    db,
    getEmbedPort,
    getVectorIndex,
    getModelUri,
    onEmbedded,
    embedBacklogFn = embedBacklog,
    acquireWriteLease,
  } = deps;

  // State
  let pendingCount = 0; // Track pending triggers (not actual docIds - we embed full backlog)
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let needsRerun = false;
  let firstPendingAt: number | null = null;
  let nextRunAt: number | null = null; // Accurate timer due time
  let disposed = false;
  let currentRun: Promise<EmbedResult | null> | null = null;
  let lastRunAt: number | null = null;
  let lastResult: EmbedResult | null = null;
  let runningSince: number | null = null;
  let consecutiveFailures = 0;
  let parked = false;
  const controller = new AbortController();

  const stats = createVectorStatsPort(db);

  /**
   * Run embedding for pending docs using shared helper.
   * Uses global backlog - we don't filter by docIds since:
   * 1. Backlog query is already efficient (only unembedded chunks)
   * 2. Filtering by docId would require joining through documents table
   * 3. Simpler to just embed all backlog when triggered
   */
  async function runEmbed(): Promise<PassOutcome> {
    // Resolve dependencies at execution time (survives context reloads)
    const embedPort = getEmbedPort();
    const vectorIndex = getVectorIndex();
    const modelUri = getModelUri();

    if (!embedPort || !vectorIndex) {
      return { result: { embedded: 0, errors: 0 } };
    }

    let result: Awaited<ReturnType<typeof embedBacklogFn>>;
    try {
      result = await withBackgroundInference(() =>
        withOwnedInferenceScope({ signal: controller.signal }, () =>
          embedBacklogFn({
            statsPort: stats,
            embedPort,
            vectorIndex,
            modelUri,
            batchSize: BATCH_SIZE,
            acquireWriteTurn: acquireWriteLease,
            identityStillCurrent: () =>
              getEmbedPort() === embedPort &&
              getVectorIndex() === vectorIndex &&
              getModelUri() === modelUri,
          })
        )
      );
    } catch (cause) {
      if (controller.signal.aborted)
        return { result: { embedded: 0, errors: 0 } };
      // An inference deadline or worker exit aborts the whole pass. It is a
      // failed pass like any other, never a silently dropped rejection.
      return {
        result: { embedded: 0, errors: 0 },
        failure: cause instanceof Error ? cause.message : String(cause),
      };
    }

    if (!result.ok) {
      return {
        result: { embedded: 0, errors: 0 },
        failure: result.error.message,
      };
    }
    if (
      getEmbedPort() !== embedPort ||
      getVectorIndex() !== vectorIndex ||
      getModelUri() !== modelUri
    )
      needsRerun = true;
    if (result.value.deferred) needsRerun = true;
    if (result.value.embedded > 0) onEmbedded?.(result.value);
    const contended = result.value.contentionErrors ?? 0;
    const deferred = result.value.deferred === true;
    // Provider failures and contended checkpoints remain durably pending.
    return result.value.errors > 0 || contended > 0
      ? {
          result: result.value,
          deferred,
          failure: `${result.value.errors} embedding errors, ${contended} contended writes`,
        }
      : { result: result.value, deferred };
  }

  /** Count a failed pass and schedule its bounded retry, logging each step once. */
  function recordFailure(message: string): void {
    consecutiveFailures += 1;
    if (parked) return;
    if (consecutiveFailures >= MAX_FAILED_PASSES) {
      parked = true;
      console.error(
        `[embed-scheduler] Embed pass failed ${consecutiveFailures} times (${message}); automatic retries parked. Pending chunks stay queued for new changes or \`gno embed\`.`
      );
      return;
    }
    const delay = failedPassRetryDelayMs(consecutiveFailures);
    console.error(
      `[embed-scheduler] Embed pass failed (${consecutiveFailures}/${MAX_FAILED_PASSES}): ${message}; retrying in ${Math.round(delay / 1000)}s`
    );
    scheduleRun(delay);
  }

  /**
   * Schedule or reschedule the debounced embed run.
   */
  function scheduleRun(retryDelay?: number): void {
    if (disposed) {
      return;
    }

    // If currently running, mark for rerun instead of scheduling
    if (running) {
      needsRerun = true;
      return;
    }

    // Calculate delay
    const now = Date.now();
    let delay = retryDelay ?? DEBOUNCE_MS;

    // Check max-wait
    if (firstPendingAt !== null) {
      const elapsed = now - firstPendingAt;
      if (elapsed >= MAX_WAIT_MS) {
        // Max wait reached, run immediately
        delay = 0;
      } else {
        // Don't exceed max wait
        delay = Math.min(delay, MAX_WAIT_MS - elapsed);
      }
    }

    // Clear existing timer
    if (timer) {
      clearTimeout(timer);
    }

    // Track accurate due time
    nextRunAt = now + delay;

    timer = setTimeout(() => {
      nextRunAt = null;
      void executeRun();
    }, delay);
  }

  /**
   * Execute the embed run with concurrency guard.
   */
  function executeRun(): Promise<EmbedResult | null> {
    if (disposed || running) {
      needsRerun = true;
      return Promise.resolve(null);
    }

    const operation = (async (): Promise<EmbedResult | null> => {
      running = true;
      timer = null;
      nextRunAt = null;

      // Clear pending state at START so new notifications accumulate
      pendingCount = 0;
      firstPendingAt = null;

      runningSince = Date.now();
      let outcome: PassOutcome;
      try {
        outcome = await runEmbed();
        lastRunAt = Date.now();
        lastResult = outcome.result;
      } finally {
        running = false;
        runningSince = null;
      }
      const result = outcome.result;

      // Must be AFTER running=false so scheduleRun() actually schedules
      if (outcome.failure !== undefined && !disposed) {
        // A failed pass never reruns immediately: the bounded retry covers work
        // that arrived meanwhile, and once parked only fresh work earns a pass.
        needsRerun = false;
        recordFailure(outcome.failure);
        if (parked && pendingCount > 0) {
          firstPendingAt ??= Date.now();
          scheduleRun();
        }
        return result;
      }
      // Only a pass that reached the end of the backlog cleanly clears failures.
      if (outcome.failure === undefined && !outcome.deferred) {
        consecutiveFailures = 0;
        parked = false;
      }

      // Check if we need to rerun (notifications arrived while running)
      if ((needsRerun || pendingCount > 0) && !disposed) {
        needsRerun = false;
        // Set firstPendingAt if we have pending work
        if (pendingCount > 0 && firstPendingAt === null) {
          firstPendingAt = Date.now();
        }
        scheduleRun();
      }

      return result;
    })();
    currentRun = operation;
    void operation.then(
      () => {
        if (currentRun === operation) currentRun = null;
      },
      () => {
        if (currentRun === operation) currentRun = null;
      }
    );
    return operation;
  }

  const stop = async (): Promise<void> => {
    disposed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    nextRunAt = null;
    await currentRun;
  };

  return {
    stop,
    notifySyncComplete(docIds: string[]): void {
      // Resolve embedPort at call time to check availability
      if (disposed || !getEmbedPort()) {
        return;
      }

      // Track first pending time for max-wait
      if (pendingCount === 0 && firstPendingAt === null) {
        firstPendingAt = Date.now();
      }

      // Count pending triggers (we don't track individual docIds)
      pendingCount += docIds.length;

      // Schedule/reschedule debounced run (or mark needsRerun if running)
      scheduleRun();
    },

    async triggerNow(): Promise<EmbedResult | null> {
      if (disposed || !getEmbedPort()) {
        return null;
      }

      // Cancel pending timer
      if (timer) {
        clearTimeout(timer);
        timer = null;
        nextRunAt = null;
      }

      // If already running, mark for rerun
      if (running) {
        needsRerun = true;
        return { embedded: 0, errors: 0 };
      }

      return executeRun();
    },

    getState(): EmbedSchedulerState {
      const state: EmbedSchedulerState = {
        pendingDocCount: pendingCount,
        running,
        consecutiveFailures,
        parked,
      };
      if (runningSince !== null) state.runningSince = runningSince;

      // Use accurate nextRunAt from timer scheduling
      if (nextRunAt !== null) {
        state.nextRunAt = nextRunAt;
      }
      if (lastRunAt !== null) {
        state.lastRunAt = lastRunAt;
      }
      if (lastResult) {
        state.lastResult = lastResult;
      }

      return state;
    },

    async dispose(): Promise<void> {
      controller.abort();
      await stop();
    },
  };
}
