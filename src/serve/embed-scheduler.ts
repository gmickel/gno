/**
 * Debounced embedding scheduler for web UI.
 * Accumulates docIds from sync operations and runs embedding after debounce.
 *
 * @module src/serve/embed-scheduler
 */

import type { Database } from "bun:sqlite";

import type { EmbeddingPort } from "../llm/types";
import type { BacklogItem, VectorIndexPort, VectorRow } from "../store/vector";

import { formatDocForEmbedding } from "../pipeline/contextual";
import { createVectorStatsPort } from "../store/vector";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 30_000; // 30 seconds
const MAX_WAIT_MS = 300_000; // 5 minutes
const BATCH_SIZE = 32;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface EmbedSchedulerState {
  pendingDocCount: number;
  running: boolean;
  nextRunAt?: number;
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
  dispose(): void;
}

/**
 * Create an embed scheduler for debounced background embedding.
 * Uses getters to resolve dependencies at execution time (survives context reloads).
 */
export function createEmbedScheduler(deps: EmbedSchedulerDeps): EmbedScheduler {
  const { db, getEmbedPort, getVectorIndex, getModelUri } = deps;

  // State
  let pendingCount = 0; // Track pending triggers (not actual docIds - we embed full backlog)
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let needsRerun = false;
  let firstPendingAt: number | null = null;
  let nextRunAt: number | null = null; // Accurate timer due time
  let disposed = false;

  const stats = createVectorStatsPort(db);

  /**
   * Run embedding for pending docs.
   * Uses global backlog - we don't filter by docIds since:
   * 1. Backlog query is already efficient (only unembedded chunks)
   * 2. Filtering by docId would require joining through documents table
   * 3. Simpler to just embed all backlog when triggered
   */
  async function runEmbed(): Promise<EmbedResult> {
    // Resolve dependencies at execution time (survives context reloads)
    const embedPort = getEmbedPort();
    const vectorIndex = getVectorIndex();
    const modelUri = getModelUri();

    if (!embedPort || !vectorIndex) {
      return { embedded: 0, errors: 0 };
    }

    let embedded = 0;
    let errors = 0;
    let cursor: { mirrorHash: string; seq: number } | undefined;

    try {
      // Process all backlog in batches
      while (true) {
        const batchResult = await stats.getBacklog(modelUri, {
          limit: BATCH_SIZE,
          after: cursor,
        });

        if (!batchResult.ok) {
          console.error(
            "[embed-scheduler] Backlog query failed:",
            batchResult.error.message
          );
          break;
        }

        const batch = batchResult.value;
        if (batch.length === 0) {
          break;
        }

        // Advance cursor
        const lastItem = batch.at(-1);
        if (lastItem) {
          cursor = { mirrorHash: lastItem.mirrorHash, seq: lastItem.seq };
        }

        // Embed batch
        const embedResult = await embedPort.embedBatch(
          batch.map((b: BacklogItem) =>
            formatDocForEmbedding(b.text, b.title ?? undefined)
          )
        );

        if (!embedResult.ok) {
          console.error(
            "[embed-scheduler] Embed failed:",
            embedResult.error.message
          );
          errors += batch.length;
          continue;
        }

        const embeddings = embedResult.value;
        if (embeddings.length !== batch.length) {
          errors += batch.length;
          continue;
        }

        // Store vectors with current model URI
        const vectors: VectorRow[] = batch.map(
          (b: BacklogItem, idx: number) => ({
            mirrorHash: b.mirrorHash,
            seq: b.seq,
            model: modelUri,
            embedding: new Float32Array(embeddings[idx] as number[]),
            embeddedAt: new Date().toISOString(),
          })
        );

        const storeResult = await vectorIndex.upsertVectors(vectors);
        if (!storeResult.ok) {
          console.error(
            "[embed-scheduler] Store failed:",
            storeResult.error.message
          );
          errors += batch.length;
          continue;
        }

        embedded += batch.length;
      }
    } catch (e) {
      console.error("[embed-scheduler] Unexpected error:", e);
    }

    return { embedded, errors };
  }

  /**
   * Schedule or reschedule the debounced embed run.
   */
  function scheduleRun(): void {
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
    let delay = DEBOUNCE_MS;

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
  async function executeRun(): Promise<EmbedResult | null> {
    if (disposed || running) {
      needsRerun = true;
      return null;
    }

    running = true;
    timer = null;
    nextRunAt = null;

    // Clear pending state at START so new notifications accumulate
    pendingCount = 0;
    firstPendingAt = null;

    let result: EmbedResult;
    try {
      result = await runEmbed();
    } finally {
      running = false;
    }

    // Check if we need to rerun (notifications arrived while running)
    // Must be AFTER running=false so scheduleRun() actually schedules
    if ((needsRerun || pendingCount > 0) && !disposed) {
      needsRerun = false;
      // Set firstPendingAt if we have pending work
      if (pendingCount > 0 && firstPendingAt === null) {
        firstPendingAt = Date.now();
      }
      scheduleRun();
    }

    return result;
  }

  return {
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
      };

      // Use accurate nextRunAt from timer scheduling
      if (nextRunAt !== null) {
        state.nextRunAt = nextRunAt;
      }

      return state;
    },

    dispose(): void {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
        nextRunAt = null;
      }
    },
  };
}
