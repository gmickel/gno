/**
 * Shared embedding batch helpers.
 *
 * @module src/embed/batch
 */

import type { EmbeddingPort, LlmResult } from "../llm/types";

import { getEmbeddingCompatibilityProfile } from "../llm/embedding-compatibility";
import { inferenceFailedError } from "../llm/errors";

export interface EmbedBatchRecoveryResult {
  vectors: Array<number[] | null>;
  batchFailed: boolean;
  batchError?: string;
  fallbackErrors: number;
}

function errorMessage(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

export async function embedTextsWithRecovery(
  embedPort: EmbeddingPort,
  texts: string[]
): Promise<LlmResult<EmbedBatchRecoveryResult>> {
  if (texts.length === 0) {
    return {
      ok: true,
      value: {
        vectors: [],
        batchFailed: false,
        fallbackErrors: 0,
      },
    };
  }

  const profile = getEmbeddingCompatibilityProfile(embedPort.modelUri);
  if (profile.batchEmbeddingTrusted) {
    const batchResult = await embedPort.embedBatch(texts);
    if (batchResult.ok && batchResult.value.length === texts.length) {
      return {
        ok: true,
        value: {
          vectors: batchResult.value,
          batchFailed: false,
          fallbackErrors: 0,
        },
      };
    }

    const recovered = await recoverIndividually(embedPort, texts);
    if (!recovered.ok) {
      return recovered;
    }
    return {
      ok: true,
      value: {
        ...recovered.value,
        batchFailed: true,
        batchError: batchResult.ok
          ? `Embedding count mismatch: got ${batchResult.value.length}, expected ${texts.length}`
          : batchResult.error.message,
      },
    };
  }

  const recovered = await recoverIndividually(embedPort, texts);
  if (!recovered.ok) {
    return recovered;
  }
  return {
    ok: true,
    value: {
      ...recovered.value,
      batchFailed: true,
      batchError: "Batch embedding disabled for this compatibility profile",
    },
  };
}

async function recoverIndividually(
  embedPort: EmbeddingPort,
  texts: string[]
): Promise<
  LlmResult<Omit<EmbedBatchRecoveryResult, "batchFailed" | "batchError">>
> {
  try {
    const vectors: Array<number[] | null> = [];
    let fallbackErrors = 0;

    for (const text of texts) {
      const result = await embedPort.embed(text);
      if (result.ok) {
        vectors.push(result.value);
      } else {
        vectors.push(null);
        fallbackErrors += 1;
      }
    }

    return {
      ok: true,
      value: {
        vectors,
        fallbackErrors,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: inferenceFailedError(
        embedPort.modelUri,
        new Error(errorMessage(error))
      ),
    };
  }
}
