import { type LlmError, llmError } from "../errors";

export type NativeWorkerFailure =
  | "protocol"
  | "overloaded"
  | "oversized"
  | "stale_generation"
  | "duplicate_completion"
  | "exited"
  | "timeout";

/** Stable host errors; never include payloads or child stderr in caller output. */
export class NativeWorkerError extends Error {
  readonly detail: LlmError;

  constructor(readonly reason: NativeWorkerFailure) {
    super(`Native worker failure: ${reason}`);
    this.name = "NativeWorkerError";
    this.detail = llmError(
      reason === "timeout" ? "TIMEOUT" : "INFERENCE_FAILED",
      {
        message: this.message,
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
