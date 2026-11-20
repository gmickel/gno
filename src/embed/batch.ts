import type { EmbeddingPort, LlmResult } from "../llm/types";
/**
 * Shared embedding batch helpers.
 *
 * @module src/embed/batch
 */

import { getEmbeddingCompatibilityProfile } from "../llm/embedding-compatibility";
import { inferenceFailedError } from "../llm/errors";
import {
  assertInferenceActive,
  assertInferenceResult,
  isBackgroundInference,
} from "../llm/inference-scope";

export interface EmbedBatchRecoveryResult {
  vectors: Array<number[] | null>;
  batchFailed: boolean;
  batchError?: string;
  fallbackErrors: number;
  failureSamples: string[];
  retrySuggestion?: string;
}

const MAX_FAILURE_SAMPLES = 5;

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

function formatFailureMessage(error: {
  message: string;
  cause?: unknown;
}): string {
  const cause = error.cause ? errorMessage(error.cause) : "";
  return cause && cause !== error.message
    ? `${error.message} - ${cause}`
    : error.message;
}

function isDisposedFailure(message: string): boolean {
  return message.toLowerCase().includes("object is disposed");
}

async function resetEmbeddingPort(
  embedPort: EmbeddingPort
): Promise<LlmResult<void>> {
  await embedPort.dispose();
  return embedPort.init();
}

export interface EmbedRecoveryOptions {
  /**
   * Called before each provider request with the number of texts it submits,
   * including resubmissions after a port reset and adaptive recovery. Bounded
   * runs charge these against `--max-chunks`.
   */
  onSubmit?: (texts: number) => void;
}

/** Report each provider request to `onSubmit` before it is sent. */
function meteredPort(
  embedPort: EmbeddingPort,
  onSubmit: ((texts: number) => void) | undefined
): Pick<EmbeddingPort, "embed" | "embedBatch"> {
  return {
    embed: (text) => {
      onSubmit?.(1);
      return embedPort.embed(text);
    },
    embedBatch: (texts) => {
      onSubmit?.(texts.length);
      return embedPort.embedBatch(texts);
    },
  };
}

export async function embedTextsWithRecovery(
  embedPort: EmbeddingPort,
  texts: string[],
  options: EmbedRecoveryOptions = {}
): Promise<LlmResult<EmbedBatchRecoveryResult>> {
  if (texts.length === 0) {
    return {
      ok: true,
      value: {
        vectors: [],
        batchFailed: false,
        fallbackErrors: 0,
        failureSamples: [],
      },
    };
  }

  const provider = meteredPort(embedPort, options.onSubmit);
  const profile = getEmbeddingCompatibilityProfile(embedPort.modelUri);
  // A background page gets one provider attempt. Recovery remains durable for
  // the next pass instead of expanding the current native scheduling turn.
  if (isBackgroundInference() && profile.batchEmbeddingTrusted) {
    const result = await provider.embedBatch(texts);
    assertInferenceResult(result);
    if (!result.ok) return result;
    const complete = result.value.length === texts.length;
    return {
      ok: true,
      value: {
        vectors: complete ? result.value : texts.map(() => null),
        batchFailed: !complete,
        fallbackErrors: complete ? 0 : texts.length,
        failureSamples: complete ? [] : ["Embedding count mismatch"],
      },
    };
  }
  if (profile.batchEmbeddingTrusted) {
    let batchResult = await provider.embedBatch(texts);
    assertInferenceResult(batchResult);
    if (!batchResult.ok) {
      const formattedBatchError = formatFailureMessage(batchResult.error);
      if (isDisposedFailure(formattedBatchError)) {
        const reset = await resetEmbeddingPort(embedPort);
        if (!reset.ok) {
          return reset;
        }
        batchResult = await provider.embedBatch(texts);
        assertInferenceResult(batchResult);
      }
    }
    if (batchResult.ok && batchResult.value.length === texts.length) {
      return {
        ok: true,
        value: {
          vectors: batchResult.value,
          batchFailed: false,
          fallbackErrors: 0,
          failureSamples: [],
        },
      };
    }

    const recovered = await recoverWithAdaptiveBatches(
      embedPort,
      provider,
      texts,
      {
        rootBatchAlreadyFailed: true,
      }
    );
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
          : formatFailureMessage(batchResult.error),
        retrySuggestion:
          recovered.value.fallbackErrors > 0
            ? "Try rerunning the same command. If failures persist, rerun with `gno --verbose embed --batch-size 1` to isolate failing chunks."
            : undefined,
      },
    };
  }

  const recovered = await recoverIndividually(embedPort, provider, texts);
  if (!recovered.ok) {
    return recovered;
  }
  return {
    ok: true,
    value: {
      ...recovered.value,
      batchFailed: true,
      batchError: "Batch embedding disabled for this compatibility profile",
      retrySuggestion:
        recovered.value.fallbackErrors > 0
          ? "Some chunks still failed individually. Rerun with `gno --verbose embed --batch-size 1` for exact chunk errors."
          : undefined,
    },
  };
}

async function recoverWithAdaptiveBatches(
  embedPort: EmbeddingPort,
  provider: Pick<EmbeddingPort, "embed" | "embedBatch">,
  texts: string[],
  options: { rootBatchAlreadyFailed?: boolean } = {}
): Promise<
  LlmResult<Omit<EmbedBatchRecoveryResult, "batchFailed" | "batchError">>
> {
  try {
    const vectors: Array<number[] | null> = Array.from(
      { length: texts.length },
      () => null
    );
    const failureSamples: string[] = [];
    let fallbackErrors = 0;

    const recordFailure = (message: string): void => {
      if (failureSamples.length < MAX_FAILURE_SAMPLES) {
        failureSamples.push(message);
      }
    };

    const processRange = async (
      rangeTexts: string[],
      offset: number,
      batchAlreadyFailed = false
    ): Promise<void> => {
      if (rangeTexts.length === 0) {
        return;
      }

      if (rangeTexts.length === 1) {
        const result = await provider.embed(rangeTexts[0] ?? "");
        assertInferenceResult(result);
        if (result.ok) {
          vectors[offset] = result.value;
          return;
        }
        fallbackErrors += 1;
        recordFailure(formatFailureMessage(result.error));
        return;
      }

      let batchResult: Awaited<ReturnType<typeof embedPort.embedBatch>> | null =
        null;
      if (!batchAlreadyFailed) {
        batchResult = await provider.embedBatch(rangeTexts);
        assertInferenceResult(batchResult);
      }
      if (
        batchResult &&
        batchResult.ok &&
        batchResult.value.length === rangeTexts.length
      ) {
        for (const [index, vector] of batchResult.value.entries()) {
          assertInferenceActive();
          vectors[offset + index] = vector;
        }
        return;
      }

      const mid = Math.ceil(rangeTexts.length / 2);
      await processRange(rangeTexts.slice(0, mid), offset);
      await processRange(rangeTexts.slice(mid), offset + mid);
    };

    await processRange(texts, 0, options.rootBatchAlreadyFailed ?? false);

    if (fallbackErrors === texts.length) {
      const reinit = await resetEmbeddingPort(embedPort);
      if (!reinit.ok) {
        return reinit;
      }

      const retry = await recoverIndividually(embedPort, provider, texts);
      if (!retry.ok) {
        return retry;
      }
      return {
        ok: true,
        value: retry.value,
      };
    }

    return {
      ok: true,
      value: {
        vectors,
        fallbackErrors,
        failureSamples,
      },
    };
  } catch (error) {
    assertInferenceActive();
    if (
      error instanceof Error &&
      ["AbortError", "TimeoutError"].includes(error.name)
    )
      throw error;
    return {
      ok: false,
      error: inferenceFailedError(
        embedPort.modelUri,
        new Error(errorMessage(error))
      ),
    };
  }
}

async function recoverIndividually(
  embedPort: EmbeddingPort,
  provider: Pick<EmbeddingPort, "embed" | "embedBatch">,
  texts: string[]
): Promise<
  LlmResult<Omit<EmbedBatchRecoveryResult, "batchFailed" | "batchError">>
> {
  try {
    const vectors: Array<number[] | null> = [];
    const failureSamples: string[] = [];
    let fallbackErrors = 0;

    for (const text of texts) {
      assertInferenceActive();
      const result = await provider.embed(text);
      assertInferenceResult(result);
      if (result.ok) {
        vectors.push(result.value);
      } else {
        vectors.push(null);
        fallbackErrors += 1;
        if (failureSamples.length < MAX_FAILURE_SAMPLES) {
          failureSamples.push(formatFailureMessage(result.error));
        }
      }
    }

    return {
      ok: true,
      value: {
        vectors,
        fallbackErrors,
        failureSamples,
      },
    };
  } catch (error) {
    assertInferenceActive();
    if (
      error instanceof Error &&
      ["AbortError", "TimeoutError"].includes(error.name)
    )
      throw error;
    return {
      ok: false,
      error: inferenceFailedError(
        embedPort.modelUri,
        new Error(errorMessage(error))
      ),
    };
  }
}
