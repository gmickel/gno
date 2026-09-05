/** Internal lifetime contract shared by inference owners. Cancellation settles
 * the caller once; only native settlement releases active ownership. Wiring the
 * signal into a backend is the owner's responsibility, not proof of interruption.
 */
import type { LlmError } from "./errors";
import type { InferenceOptions, LlmResult } from "./types";

import { llmError } from "./errors";

const MAX_TIMER_MS = 2_147_483_647;
export type InferencePhase =
  | "queued"
  | "native-active"
  | "response-pending"
  | "settled";

/** Stable structural discriminator; do not inspect human-readable messages. */
export function isInferenceCancellation(error: LlmError): boolean {
  return (
    error.code === "INFERENCE_FAILED" &&
    typeof error.cause === "object" &&
    error.cause !== null &&
    "name" in error.cause &&
    error.cause.name === "AbortError"
  );
}

export class InferenceSettlement<T> {
  private state: InferencePhase = "queued";
  private delivered = false;
  private executionStarted = false;
  private executionDeadline?: number;
  private result?: LlmResult<T>;
  private deadlineTimer?: ReturnType<typeof setTimeout>;
  private executionTimer?: ReturnType<typeof setTimeout>;
  private readonly controller = new AbortController();
  private readonly delivery = Promise.withResolvers<LlmResult<T>>();
  readonly completion = this.delivery.promise;
  readonly signal = this.controller.signal;

  constructor(
    private readonly options: InferenceOptions = {},
    private readonly inferenceTimeout = 30_000
  ) {
    if (
      !Number.isInteger(inferenceTimeout) ||
      inferenceTimeout < 1 ||
      inferenceTimeout > MAX_TIMER_MS
    )
      throw new RangeError("Invalid inference timeout");
    if (
      options.deadlineAt !== undefined &&
      (!Number.isSafeInteger(options.deadlineAt) || options.deadlineAt < 0)
    )
      throw new RangeError("Invalid inference deadline");
    options.signal?.addEventListener("abort", this.onAbort, { once: true });
    if (options.signal?.aborted) this.cancel("abort");
    this.checkDeadline();
  }

  get phase(): InferencePhase {
    return this.state;
  }
  get ownsNative(): boolean {
    return this.state === "native-active";
  }

  /** Claim before starting model/context load, including noncooperative creation. */
  startNative(): boolean {
    this.checkDeadline();
    if (this.state !== "queued" || this.delivered) return false;
    this.state = "native-active";
    return true;
  }

  /** Called immediately before evaluation, after loading. Never resets a timer. */
  startExecution(): boolean {
    this.checkDeadline();
    if (!this.ownsNative || this.delivered || this.executionStarted)
      return false;
    this.executionStarted = true;
    this.executionDeadline = performance.now() + this.inferenceTimeout;
    this.executionTimer = setTimeout(
      () => this.cancel("timeout"),
      this.inferenceTimeout
    );
    return true;
  }

  /** Call only after the native promise settles or owned-child exit is confirmed.
   * A cancellation acknowledgement alone is insufficient to release the lease.
   */
  nativeSettled(result: LlmResult<T>): void {
    if (!this.ownsNative) return;
    this.checkDeadline();
    clearTimeout(this.executionTimer);
    this.executionDeadline = undefined;
    this.result = result;
    this.state = this.delivered ? "settled" : "response-pending";
  }

  /** Keep caller deadline/abort live through response validation and publication. */
  publish(): boolean {
    this.checkDeadline();
    if (this.state !== "response-pending" || this.delivered || !this.result)
      return false;
    this.deliver(this.result);
    return true;
  }

  /** Fail caller delivery while retaining native ownership until exit/settlement. */
  fail(error: LlmError): void {
    if (!this.delivered) this.deliver({ ok: false, error });
  }

  cancel(reason: "abort" | "timeout"): void {
    if (this.delivered) return;
    const cause = new DOMException(
      reason === "abort"
        ? "Inference cancelled"
        : "Inference deadline exceeded",
      reason === "abort" ? "AbortError" : "TimeoutError"
    );
    // Settle first: synchronous abort listeners cannot publish a late success.
    this.deliver({
      ok: false,
      error: llmError(reason === "abort" ? "INFERENCE_FAILED" : "TIMEOUT", {
        message: cause.message,
        retryable: false,
        cause,
      }),
    });
    this.controller.abort(cause);
  }

  private readonly onAbort = (): void => {
    this.cancel("abort");
  };

  private checkDeadline(): void {
    clearTimeout(this.deadlineTimer);
    if (this.delivered) return;
    if (
      this.executionDeadline !== undefined &&
      performance.now() >= this.executionDeadline
    ) {
      this.cancel("timeout");
      return;
    }
    if (this.options.deadlineAt === undefined) return;
    const remaining = this.options.deadlineAt - Date.now();
    if (remaining <= 0) this.cancel("timeout");
    else
      this.deadlineTimer = setTimeout(
        () => this.checkDeadline(),
        Math.min(remaining, MAX_TIMER_MS)
      );
  }

  private deliver(result: LlmResult<T>): void {
    this.delivered = true;
    if (!this.ownsNative) this.state = "settled";
    clearTimeout(this.deadlineTimer);
    clearTimeout(this.executionTimer);
    this.options.signal?.removeEventListener("abort", this.onAbort);
    this.delivery.resolve(result);
  }
}
