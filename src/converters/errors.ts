/**
 * Converter error types and helpers.
 * PRD §8.3 - Error model
 */

import type { ConvertError, ConvertErrorCode, ConvertInput } from "./types";

type ConvertErrorOpts = Omit<ConvertError, "code">;

/** Max length for error messages/causes to prevent bloat */
const MAX_CAUSE_LENGTH = 1000;

/**
 * Normalize a cause to a safe, serializable format.
 * Extracts essential info from Error objects, limits length.
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

  if (typeof cause === "string") {
    return cause.length > MAX_CAUSE_LENGTH
      ? `${cause.slice(0, MAX_CAUSE_LENGTH)}...`
      : cause;
  }

  // For other types, try to stringify safely
  try {
    // Handle objects with custom toString, otherwise use JSON
    const str =
      typeof cause === "object" && cause !== null
        ? JSON.stringify(cause)
        : String(cause as string | number | boolean);
    return str.length > MAX_CAUSE_LENGTH
      ? `${str.slice(0, MAX_CAUSE_LENGTH)}...`
      : str;
  } catch {
    return "[unserializable cause]";
  }
}

/**
 * Create a ConvertError with the given code and options.
 * Normalizes cause to prevent bloat and serialization issues.
 */
export function convertError(
  code: ConvertErrorCode,
  opts: ConvertErrorOpts
): ConvertError {
  return {
    code,
    ...opts,
    cause: normalizeCause(opts.cause),
  };
}

/**
 * Check if an error code indicates a retryable failure.
 */
export function isRetryable(code: ConvertErrorCode): boolean {
  return ["TIMEOUT", "IO", "ADAPTER_FAILURE"].includes(code);
}

/**
 * Create a standard error result for unsupported file types.
 */
export function unsupportedError(
  input: Pick<ConvertInput, "sourcePath" | "mime" | "ext">,
  converterId = "registry"
): ConvertError {
  return convertError("UNSUPPORTED", {
    message: `No converter for ${input.mime} (${input.ext})`,
    retryable: false,
    fatal: false,
    converterId,
    sourcePath: input.sourcePath,
    mime: input.mime,
    ext: input.ext,
  });
}

/**
 * Create an error for files exceeding size limits.
 */
export function tooLargeError(
  input: Pick<ConvertInput, "sourcePath" | "mime" | "ext" | "bytes" | "limits">,
  converterId: string
): ConvertError {
  return convertError("TOO_LARGE", {
    message: `File size ${input.bytes.length} exceeds limit ${input.limits.maxBytes}`,
    retryable: false,
    fatal: false,
    converterId,
    sourcePath: input.sourcePath,
    mime: input.mime,
    ext: input.ext,
    details: {
      size: input.bytes.length,
      limit: input.limits.maxBytes,
    },
  });
}

/**
 * Create an error for conversion output exceeding size limits.
 * Distinct from tooLargeError (input) - this is for output (zip bomb protection).
 */
export function outputTooLargeError(
  input: Pick<ConvertInput, "sourcePath" | "mime" | "ext">,
  converterId: string,
  opts: { outputChars: number; limitChars: number; stage: "raw" | "canonical" }
): ConvertError {
  return convertError("TOO_LARGE", {
    message: `Conversion output (${opts.outputChars} chars at ${opts.stage}) exceeds limit ${opts.limitChars}`,
    retryable: false,
    fatal: false,
    converterId,
    sourcePath: input.sourcePath,
    mime: input.mime,
    ext: input.ext,
    details: {
      outputChars: opts.outputChars,
      limitChars: opts.limitChars,
      stage: opts.stage,
    },
  });
}

/**
 * Create an error for conversion timeouts.
 */
export function timeoutError(
  input: Pick<ConvertInput, "sourcePath" | "mime" | "ext" | "limits">,
  converterId: string
): ConvertError {
  return convertError("TIMEOUT", {
    message: `Conversion timed out after ${input.limits.timeoutMs}ms`,
    retryable: true,
    fatal: false,
    converterId,
    sourcePath: input.sourcePath,
    mime: input.mime,
    ext: input.ext,
    details: {
      timeoutMs: input.limits.timeoutMs,
    },
  });
}

/**
 * Create an error for corrupt or invalid files.
 */
export function corruptError(
  input: Pick<ConvertInput, "sourcePath" | "mime" | "ext">,
  converterId: string,
  message: string,
  cause?: unknown
): ConvertError {
  return convertError("CORRUPT", {
    message,
    retryable: false,
    fatal: false,
    converterId,
    sourcePath: input.sourcePath,
    mime: input.mime,
    ext: input.ext,
    cause,
  });
}

/**
 * Create an error for permission-gated files (for example password-protected documents).
 */
export function permissionError(
  input: Pick<ConvertInput, "sourcePath" | "mime" | "ext">,
  converterId: string,
  message: string,
  cause?: unknown,
  details?: Record<string, unknown>
): ConvertError {
  return convertError("PERMISSION", {
    message,
    retryable: false,
    fatal: false,
    converterId,
    sourcePath: input.sourcePath,
    mime: input.mime,
    ext: input.ext,
    cause,
    details,
  });
}

/**
 * Create an error for adapter-level failures.
 */
export function adapterError(
  input: Pick<ConvertInput, "sourcePath" | "mime" | "ext">,
  converterId: string,
  message: string,
  cause?: unknown
): ConvertError {
  return convertError("ADAPTER_FAILURE", {
    message,
    retryable: true,
    fatal: false,
    converterId,
    sourcePath: input.sourcePath,
    mime: input.mime,
    ext: input.ext,
    cause,
  });
}

/**
 * Create an error for internal pipeline failures.
 */
export function internalError(
  input: Pick<ConvertInput, "sourcePath" | "mime" | "ext">,
  converterId: string,
  message: string,
  cause?: unknown
): ConvertError {
  return convertError("INTERNAL", {
    message,
    retryable: false,
    fatal: true,
    converterId,
    sourcePath: input.sourcePath,
    mime: input.mime,
    ext: input.ext,
    cause,
  });
}
