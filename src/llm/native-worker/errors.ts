import { type LlmError, llmError } from "../errors";

export type NativeWorkerFailure =
  | "protocol"
  | "overloaded"
  | "oversized"
  | "stale_generation"
  | "duplicate_completion"
  | "exited"
  | "timeout";

const MAX_START_CAUSE_LENGTH = 300;

/** One-line description of a host-side failure, bounded for caller output. */
function describeCause(cause: unknown): string {
  const text =
    cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  return text.length > MAX_START_CAUSE_LENGTH
    ? `${text.slice(0, MAX_START_CAUSE_LENGTH)}...`
    : text;
}

/**
 * Stable host errors; never include payloads or child stderr in caller output.
 * `cause` is a host-side failure (the worker could not be started) and is
 * appended to the message so the reason is not lost behind "exited".
 */
export class NativeWorkerError extends Error {
  readonly detail: LlmError;

  constructor(
    readonly reason: NativeWorkerFailure,
    cause?: unknown
  ) {
    super(
      cause === undefined
        ? `Native worker failure: ${reason}`
        : `Native worker failure: ${reason} (${describeCause(cause)})`
    );
    this.name = "NativeWorkerError";
    this.detail = llmError(
      reason === "timeout" ? "TIMEOUT" : "INFERENCE_FAILED",
      {
        message: this.message,
        cause,
        retryable: [
          "overloaded",
          "stale_generation",
          "exited",
          "timeout",
        ].includes(reason),
      }
    );
  }
}
