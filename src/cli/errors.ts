/**
 * CLI error model aligned to spec.
 * Exit codes: 0=success, 1=validation, 2=runtime
 *
 * @module src/cli/errors
 */

// ─────────────────────────────────────────────────────────────────────────────
// Error Types
// ─────────────────────────────────────────────────────────────────────────────

export type CliErrorCode = "VALIDATION" | "RUNTIME" | "NOT_RUNNING";

export interface CliErrorOptions {
  details?: Record<string, unknown>;
  /**
   * Suppress all stderr output for this error. The exit code still
   * propagates via `exitCodeFor()`. Used for `--stop` "not-running" where
   * the spec says exit 3 silently with no envelope on either stream.
   * See `spec/cli.md` Error Output section.
   */
  silent?: boolean;
}

export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly details?: Record<string, unknown>;
  readonly silent: boolean;

  constructor(
    code: CliErrorCode,
    message: string,
    detailsOrOptions?: Record<string, unknown> | CliErrorOptions
  ) {
    super(message);
    this.code = code;
    this.name = "CliError";
    // Backwards-compat: callers passing a plain details record continue to
    // work; the new options object is detected by the `silent`/`details`
    // shape.
    if (
      detailsOrOptions &&
      ("silent" in detailsOrOptions || "details" in detailsOrOptions) &&
      // Disambiguate: a details payload could legitimately have a `details`
      // key. Treat as options only when the bag has at most the two
      // recognized keys to avoid swallowing user metadata.
      Object.keys(detailsOrOptions).every(
        (k) => k === "silent" || k === "details"
      )
    ) {
      const opts = detailsOrOptions as CliErrorOptions;
      this.details = opts.details;
      this.silent = opts.silent ?? false;
    } else {
      this.details = detailsOrOptions as Record<string, unknown> | undefined;
      this.silent = false;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exit Codes
// ─────────────────────────────────────────────────────────────────────────────

export function exitCodeFor(err: CliError): 1 | 2 | 3 {
  if (err.code === "VALIDATION") {
    return 1;
  }
  if (err.code === "NOT_RUNNING") {
    return 3;
  }
  return 2;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Formatting
// ─────────────────────────────────────────────────────────────────────────────

export interface ErrorFormatOptions {
  json?: boolean;
}

/**
 * Format error for output.
 * JSON mode returns { error: { code, message, details } } envelope.
 */
export function formatErrorForOutput(
  err: CliError,
  options: ErrorFormatOptions = {}
): string {
  if (options.json) {
    return JSON.stringify({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details && { details: err.details }),
      },
    });
  }
  return `Error: ${err.message}`;
}
