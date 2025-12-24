/**
 * LLM error types and helpers.
 * Follows the pattern from converters/errors.ts
 *
 * @module src/llm/errors
 */

// ─────────────────────────────────────────────────────────────────────────────
// Error Types
// ─────────────────────────────────────────────────────────────────────────────

export type LlmErrorCode =
  | 'MODEL_NOT_FOUND'
  | 'MODEL_NOT_CACHED'
  | 'MODEL_DOWNLOAD_FAILED'
  | 'MODEL_LOAD_FAILED'
  | 'MODEL_CORRUPTED'
  | 'INFERENCE_FAILED'
  | 'TIMEOUT'
  | 'OUT_OF_MEMORY'
  | 'INVALID_URI';

export type LlmError = {
  code: LlmErrorCode;
  message: string;
  modelUri?: string;
  retryable: boolean;
  cause?: unknown;
  suggestion?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_CAUSE_LENGTH = 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a cause to safe, serializable format.
 */
function normalizeCause(
  cause: unknown
): { name: string; message: string } | string | undefined {
  if (cause === undefined || cause === null) {
    return;
  }

  if (cause instanceof Error) {
    const message =
      cause.message.length > MAX_CAUSE_LENGTH
        ? `${cause.message.slice(0, MAX_CAUSE_LENGTH)}...`
        : cause.message;
    return { name: cause.name, message };
  }

  if (typeof cause === 'string') {
    return cause.length > MAX_CAUSE_LENGTH
      ? `${cause.slice(0, MAX_CAUSE_LENGTH)}...`
      : cause;
  }

  try {
    const str = String(cause);
    return str.length > MAX_CAUSE_LENGTH
      ? `${str.slice(0, MAX_CAUSE_LENGTH)}...`
      : str;
  } catch {
    return '[unserializable cause]';
  }
}

/**
 * Create an LlmError with normalized cause.
 */
export function llmError(
  code: LlmErrorCode,
  opts: Omit<LlmError, 'code'>
): LlmError {
  return {
    code,
    ...opts,
    cause: normalizeCause(opts.cause),
  };
}

/**
 * Check if error is retryable.
 */
export function isRetryable(code: LlmErrorCode): boolean {
  return ['MODEL_DOWNLOAD_FAILED', 'TIMEOUT', 'INFERENCE_FAILED'].includes(
    code
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Factories
// ─────────────────────────────────────────────────────────────────────────────

export function modelNotFoundError(uri: string, details?: string): LlmError {
  return llmError('MODEL_NOT_FOUND', {
    message: details
      ? `Model not found: ${details}`
      : `Model not found: ${uri}`,
    modelUri: uri,
    retryable: false,
  });
}

export function modelNotCachedError(
  uri: string,
  modelType: 'embed' | 'rerank' | 'gen'
): LlmError {
  return llmError('MODEL_NOT_CACHED', {
    message: `${modelType} model not cached`,
    modelUri: uri,
    retryable: false,
    suggestion: `Run: gno models pull --${modelType}`,
  });
}

export function downloadFailedError(uri: string, cause?: unknown): LlmError {
  return llmError('MODEL_DOWNLOAD_FAILED', {
    message: `Failed to download model: ${uri}`,
    modelUri: uri,
    retryable: true,
    cause,
  });
}

export function loadFailedError(uri: string, cause?: unknown): LlmError {
  return llmError('MODEL_LOAD_FAILED', {
    message: `Failed to load model: ${uri}`,
    modelUri: uri,
    retryable: false,
    cause,
    suggestion: 'Run: gno doctor',
  });
}

export function corruptedError(uri: string, cause?: unknown): LlmError {
  return llmError('MODEL_CORRUPTED', {
    message: `Model file corrupted: ${uri}`,
    modelUri: uri,
    retryable: false,
    cause,
    suggestion: 'Run: gno models clear && gno models pull',
  });
}

export function inferenceFailedError(uri: string, cause?: unknown): LlmError {
  return llmError('INFERENCE_FAILED', {
    message: `Inference failed for model: ${uri}`,
    modelUri: uri,
    retryable: true,
    cause,
  });
}

export function timeoutError(
  uri: string,
  operation: 'load' | 'inference',
  timeoutMs: number
): LlmError {
  return llmError('TIMEOUT', {
    message: `${operation} timed out after ${timeoutMs}ms`,
    modelUri: uri,
    retryable: true,
  });
}

export function outOfMemoryError(uri: string, cause?: unknown): LlmError {
  return llmError('OUT_OF_MEMORY', {
    message: `Out of memory loading model: ${uri}`,
    modelUri: uri,
    retryable: false,
    cause,
    suggestion: 'Try a smaller quantization (Q4_K_M) or close other apps',
  });
}

export function invalidUriError(uri: string, details: string): LlmError {
  return llmError('INVALID_URI', {
    message: `Invalid model URI: ${details}`,
    modelUri: uri,
    retryable: false,
  });
}
