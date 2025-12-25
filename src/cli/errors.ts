/**
 * CLI error model aligned to spec.
 * Exit codes: 0=success, 1=validation, 2=runtime
 *
 * @module src/cli/errors
 */

// ─────────────────────────────────────────────────────────────────────────────
// Error Types
// ─────────────────────────────────────────────────────────────────────────────

export type CliErrorCode = 'VALIDATION' | 'RUNTIME';

export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: CliErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = 'CliError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exit Codes
// ─────────────────────────────────────────────────────────────────────────────

export function exitCodeFor(err: CliError): 1 | 2 {
  return err.code === 'VALIDATION' ? 1 : 2;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Formatting
// ─────────────────────────────────────────────────────────────────────────────

export type ErrorFormatOptions = {
  json?: boolean;
};

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
