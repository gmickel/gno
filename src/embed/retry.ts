import type { EmbeddingPort } from "../llm/types";
import type { BacklogItem, VectorIndexPort, VectorRow } from "../store/vector";

import { formatDocForEmbedding } from "../pipeline/contextual";
import { embedTextsWithRecovery } from "./batch";

export const MAX_EMBED_CHUNK_ATTEMPTS = 2;
export const MAX_EMBED_FAILURE_SAMPLES = 5;

export interface EmbedStoreBatchResult {
  embedded: number;
  errors: number;
  retryItems: BacklogItem[];
  errorSamples: string[];
  suggestion?: string;
  batchFailed: boolean;
  batchError?: string;
}

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

export async function embedAndStoreBatch(params: {
  embedPort: EmbeddingPort;
  vectorIndex: VectorIndexPort;
  items: BacklogItem[];
  modelUri: string;
  embedFingerprint: string;
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
      retryItems,
      errorSamples: embedResult.value.failureSamples,
      suggestion: embedResult.value.retrySuggestion,
      batchFailed: embedResult.value.batchFailed,
      batchError: embedResult.value.batchError,
    };
  }

  const storeResult = await vectorIndex.upsertVectors(vectors);
  if (!storeResult.ok) {
    return {
      embedded: 0,
      errors: vectors.length,
      retryItems,
      errorSamples: [storeResult.error.message],
      suggestion:
        "Store write failed. Rerun `gno embed` once more; if it repeats, run `gno doctor` and `gno vec sync`.",
      batchFailed: embedResult.value.batchFailed,
      batchError: embedResult.value.batchError,
    };
  }

  return {
    embedded: vectors.length,
    errors: 0,
    retryItems,
    errorSamples: embedResult.value.failureSamples,
    suggestion: embedResult.value.retrySuggestion,
    batchFailed: embedResult.value.batchFailed,
    batchError: embedResult.value.batchError,
  };
}
