/**
 * SDK error types.
 *
 * @module src/sdk/errors
 */

export type GnoSdkErrorCode =
  | "CONFIG"
  | "VALIDATION"
  | "RUNTIME"
  | "STORE"
  | "MODEL"
  | "NOT_FOUND";

export interface GnoSdkErrorOptions {
  cause?: unknown;
  details?: Record<string, unknown>;
}

export class GnoSdkError extends Error {
  readonly code: GnoSdkErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: GnoSdkErrorCode,
    message: string,
    options: GnoSdkErrorOptions = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "GnoSdkError";
    this.code = code;
    this.details = options.details;
  }
}

export function sdkError(
  code: GnoSdkErrorCode,
  message: string,
  options: GnoSdkErrorOptions = {}
): GnoSdkError {
  return new GnoSdkError(code, message, options);
}
