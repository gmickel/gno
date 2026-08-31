import type { EmbeddingPort } from "../llm/types";
import type { StoreResult } from "../store/types";
import type { BacklogItem, VectorIndexPort, VectorRow } from "../store/vector";

import { isSqliteLockContention } from "../core/file-lock";
import { formatDocForEmbedding } from "../pipeline/contextual";
import { embedTextsWithRecovery } from "./batch";

export const MAX_EMBED_CHUNK_ATTEMPTS = 2;
export const MAX_EMBED_FAILURE_SAMPLES = 5;

/** Total upsert attempts (initial + retries) when persistence hits SQLITE_BUSY/LOCKED. */
export const UPSERT_CONTENTION_MAX_ATTEMPTS = 5;
export const UPSERT_CONTENTION_BASE_DELAY_MS = 250;
export const UPSERT_CONTENTION_BACKOFF_FACTOR = 2;
export const UPSERT_CONTENTION_JITTER_RATIO = 0.25;
export const UPSERT_CONTENTION_MAX_DELAY_MS = 5_000;

export const UPSERT_CONTENTION_ERROR_SAMPLE =
  "index is busy (SQLITE_BUSY) — another writer holds the database; rerun `gno embed`";

export const STORE_WRITE_FAILURE_SUGGESTION =
  "Store write failed. Rerun `gno embed` once more; if it repeats, run `gno doctor` and `gno vec sync`.";

export interface EmbedStoreBatchResult {
  embedded: number;
  errors: number;
  /**
   * Chunks whose persistence failed after SQLITE_BUSY/SQLITE_LOCKED retries.
   * Distinct from `errors` (embedding-provider / non-contention store failures).
   * Default 0.
   */
  contentionErrors: number;
  retryItems: BacklogItem[];
  errorSamples: string[];
  suggestion?: string;
  batchFailed: boolean;
  batchError?: string;
}

// fn-127 integration: CLI consumers (src/cli/commands/embed.ts,
// src/cli/commands/index-cmd.ts) must surface contentionErrors in their
// summary and exit non-zero — the integrator wires that.

export function chunkRetryKey(item: Pick<BacklogItem, "mirrorHash" | "seq">) {
  return `${item.mirrorHash}\0${item.seq}`;
}

export function addUniqueSamples(target: string[], samples: string[]): void {
  for (const sample of samples) {
    if (target.length >= MAX_EMBED_FAILURE_SAMPLES) {
      break;
    }
    if (!target.includes(sample)) {
      target.push(sample);
    }
  }
}

export function formatLlmFailure(
  error: { message: string; cause?: unknown } | undefined
): string {
  if (!error) {
    return "Unknown embedding failure";
  }
  const cause =
    error.cause &&
    typeof error.cause === "object" &&
    "message" in error.cause &&
    typeof error.cause.message === "string"
      ? error.cause.message
      : typeof error.cause === "string"
        ? error.cause
        : "";
  return cause && cause !== error.message
    ? `${error.message} - ${cause}`
    : error.message;
}

/**
 * Classify a store-layer failure as SQLite lock contention.
 * Matches SQLITE_BUSY/LOCKED on the error itself (stubs) or its `cause`
 * (upsertVectors preserves the original SQLite error there).
 */
export function isUpsertLockContention(error: {
  code?: unknown;
  cause?: unknown;
}): boolean {
  return isSqliteLockContention(error) || isSqliteLockContention(error.cause);
}

/**
 * Delay before the next upsert retry after `failedAttemptIndex` (0-based)
 * contention failures. Formula: base * factor^attempt ± jitter, capped.
 */
export function upsertContentionDelayMs(
  failedAttemptIndex: number,
  random: () => number = Math.random
): number {
  const exponential =
    UPSERT_CONTENTION_BASE_DELAY_MS *
    UPSERT_CONTENTION_BACKOFF_FACTOR ** failedAttemptIndex;
  const jitterMultiplier =
    1 + (random() * 2 - 1) * UPSERT_CONTENTION_JITTER_RATIO;
  return Math.min(
    UPSERT_CONTENTION_MAX_DELAY_MS,
    Math.max(0, exponential * jitterMultiplier)
  );
}

function resolveContentionDelayMs(
  failedAttemptIndex: number,
  delays: number[] | undefined
): number {
  if (delays) {
    return delays[failedAttemptIndex] ?? 0;
  }
  return upsertContentionDelayMs(failedAttemptIndex);
}

/**
 * Retry `upsertVectors` on SQLITE_BUSY/SQLITE_LOCKED with exponential backoff.
 * `delays` is a test seam that replaces the computed schedule (missing slots = 0).
 */
export async function upsertVectorsWithContentionRetry(
  vectorIndex: Pick<VectorIndexPort, "upsertVectors">,
  vectors: VectorRow[],
  delays?: number[]
): Promise<StoreResult<void>> {
  let storeResult = await vectorIndex.upsertVectors(vectors);
  let attempts = 1;
  while (
    !storeResult.ok &&
    isUpsertLockContention(storeResult.error) &&
    attempts < UPSERT_CONTENTION_MAX_ATTEMPTS
  ) {
    const delayMs = resolveContentionDelayMs(attempts - 1, delays);
    if (delayMs > 0) {
      await Bun.sleep(delayMs);
    }
    storeResult = await vectorIndex.upsertVectors(vectors);
    attempts += 1;
  }
  return storeResult;
}

export async function embedAndStoreBatch(params: {
  embedPort: EmbeddingPort;
  vectorIndex: VectorIndexPort;
  items: BacklogItem[];
  modelUri: string;
  embedFingerprint: string;
  /** Test seam: override contention-retry delays in milliseconds. */
  delays?: number[];
}): Promise<EmbedStoreBatchResult> {
  const { embedPort, vectorIndex, items, modelUri, embedFingerprint } = params;
  const embedResult = await embedTextsWithRecovery(
    embedPort,
    items.map((item) =>
      formatDocForEmbedding(item.text, item.title ?? undefined, modelUri)
    )
  );

  if (!embedResult.ok) {
    const formattedError = formatLlmFailure(embedResult.error);
    return {
      embedded: 0,
      errors: embedResult.error.retryable ? 0 : items.length,
      contentionErrors: 0,
      retryItems: embedResult.error.retryable ? items : [],
      errorSamples: [formattedError],
      suggestion: embedResult.error.retryable
        ? "Try rerunning the same command. If failures persist, rerun with `gno --verbose embed --batch-size 1` to isolate failing chunks."
        : embedResult.error.suggestion,
      batchFailed: true,
      batchError: formattedError,
    };
  }

  const vectors: VectorRow[] = [];
  const retryItems: BacklogItem[] = [];
  for (const [idx, item] of items.entries()) {
    const embedding = embedResult.value.vectors[idx];
    if (!embedding) {
      retryItems.push(item);
      continue;
    }
    vectors.push({
      mirrorHash: item.mirrorHash,
      seq: item.seq,
      model: modelUri,
      embedFingerprint,
      embedding: new Float32Array(embedding),
    });
  }

  if (vectors.length === 0) {
    return {
      embedded: 0,
      errors: 0,
      contentionErrors: 0,
      retryItems,
      errorSamples: embedResult.value.failureSamples,
      suggestion: embedResult.value.retrySuggestion,
      batchFailed: embedResult.value.batchFailed,
      batchError: embedResult.value.batchError,
    };
  }

  const storeResult = await upsertVectorsWithContentionRetry(
    vectorIndex,
    vectors,
    params.delays
  );
  if (!storeResult.ok) {
    if (isUpsertLockContention(storeResult.error)) {
      return {
        embedded: 0,
        errors: 0,
        contentionErrors: vectors.length,
        retryItems,
        errorSamples: [UPSERT_CONTENTION_ERROR_SAMPLE],
        suggestion: UPSERT_CONTENTION_ERROR_SAMPLE,
        batchFailed: embedResult.value.batchFailed,
        batchError: embedResult.value.batchError,
      };
    }
    return {
      embedded: 0,
      errors: vectors.length,
      contentionErrors: 0,
      retryItems,
      errorSamples: [storeResult.error.message],
      suggestion: STORE_WRITE_FAILURE_SUGGESTION,
      batchFailed: embedResult.value.batchFailed,
      batchError: embedResult.value.batchError,
    };
  }

  return {
    embedded: vectors.length,
    errors: 0,
    contentionErrors: 0,
    retryItems,
    errorSamples: embedResult.value.failureSamples,
    suggestion: embedResult.value.retrySuggestion,
    batchFailed: embedResult.value.batchFailed,
    batchError: embedResult.value.batchError,
  };
}
