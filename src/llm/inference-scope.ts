// Bun has no native async-context API; AsyncLocalStorage isolates concurrent callers.
import { AsyncLocalStorage } from "node:async_hooks";

import type { InferenceOptions, LlmResult } from "./types";

import { InferenceSettlement } from "./inference-cancellation";

interface RequestInferenceScope extends InferenceOptions {
  parent?: RequestInferenceScope;
  failure?: DOMException;
  controller?: AbortController;
}
const scope = new AsyncLocalStorage<RequestInferenceScope>();
// Internal scheduling class, separate from public inference options/model inputs.
const background = new AsyncLocalStorage<boolean>();

export function isBackgroundInference(): boolean {
  return background.getStore() === true;
}

export function withBackgroundInference<T>(
  operation: () => Promise<T>
): Promise<T> {
  return background.run(true, operation);
}

export function recordInferenceTimeout(): void {
  let current = scope.getStore();
  while (current) {
    current.failure = new DOMException(
      "Inference deadline exceeded",
      "TimeoutError"
    );
    current.controller?.abort(current.failure);
    current = current.parent;
  }
}

/** Operational metadata only: never serialized with model inputs. */
export function inferenceOptions(
  options: InferenceOptions = {}
): InferenceOptions {
  if (
    options.deadlineAt !== undefined &&
    (!Number.isSafeInteger(options.deadlineAt) || options.deadlineAt < 0)
  )
    throw new RangeError("Invalid inference deadline");
  const parent = scope.getStore();
  const signals = [
    parent?.failure ? AbortSignal.abort(parent.failure) : parent?.signal,
    options.signal,
  ].filter((signal): signal is AbortSignal => signal !== undefined);
  const deadlines = [parent?.deadlineAt, options.deadlineAt].filter(
    (deadline): deadline is number => deadline !== undefined
  );
  return {
    signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    deadlineAt: deadlines.length ? Math.min(...deadlines) : undefined,
  };
}

export function assertInferenceActive(options: InferenceOptions = {}): void {
  if (scope.getStore()?.failure) throw scope.getStore()!.failure;
  const current = inferenceOptions(options);
  if (current.signal?.aborted)
    throw new DOMException("Inference cancelled", "AbortError");
  if (current.deadlineAt !== undefined && Date.now() >= current.deadlineAt)
    throw new DOMException("Inference deadline exceeded", "TimeoutError");
}

export async function withInferenceScope<T>(
  options: InferenceOptions,
  operation: () => Promise<T>
): Promise<T> {
  const inherited = inferenceOptions(options);
  const controller = new AbortController();
  return scope.run(
    {
      ...inherited,
      signal: inherited.signal
        ? AbortSignal.any([inherited.signal, controller.signal])
        : controller.signal,
      controller,
      parent: scope.getStore(),
    },
    async () => {
      assertInferenceActive();
      const result = await operation();
      assertInferenceActive();
      return result;
    }
  );
}

/** HTTP operations own their fetch/body until settlement; abort reaches fetch. */
export function runHttpInference<T>(
  options: InferenceOptions | undefined,
  operation: (options: InferenceOptions) => Promise<LlmResult<T>>,
  inferenceTimeout = 30_000
): Promise<LlmResult<T>> {
  const settlement = new InferenceSettlement<T>(
    inferenceOptions(options),
    inferenceTimeout
  );
  if (settlement.startNative()) {
    settlement.startExecution();
    void operation({ signal: settlement.signal }).then(
      (result) => {
        settlement.nativeSettled(result);
        settlement.publish();
      },
      (cause: unknown) => {
        settlement.nativeSettled({
          ok: false,
          error: {
            code: "INFERENCE_FAILED",
            message: "HTTP inference failed",
            retryable: false,
            cause,
          },
        });
        settlement.publish();
      }
    );
  }
  return settlement.completion.then((result) => {
    if (!result.ok && result.error.code === "TIMEOUT") recordInferenceTimeout();
    return result;
  });
}

/** Never convert cancellation or timeout into retrieval fallback. */
export function assertInferenceResult<T>(result: LlmResult<T>): void {
  assertInferenceActive();
  if (
    !result.ok &&
    (result.error.code === "TIMEOUT" ||
      (typeof result.error.cause === "object" &&
        result.error.cause !== null &&
        "name" in result.error.cause &&
        result.error.cause.name === "AbortError"))
  )
    throw new DOMException(
      result.error.message,
      result.error.code === "TIMEOUT" ? "TimeoutError" : "AbortError"
    );
}

/** Owned cleanup must not inherit an expired caller, or block its delivery. */
export function finishInferenceCleanup(
  operation: () => Promise<void>
): Promise<void> {
  const cancelled =
    scope.getStore()?.failure ||
    scope.getStore()?.signal?.aborted ||
    (scope.getStore()?.deadlineAt !== undefined &&
      Date.now() >= scope.getStore()!.deadlineAt!);
  if (!cancelled) return operation();
  void scope.run({}, operation).catch(() => {});
  return Promise.resolve();
}

/** Accepted jobs own their lifetime independently of their initiating request. */
export function withOwnedInferenceScope<T>(
  options: InferenceOptions,
  operation: () => Promise<T>
): Promise<T> {
  return scope.run({}, () => withInferenceScope(options, operation));
}

/** A cancelled queued reader releases only its eventual grant, never another caller's. */
export async function acquireInferencePermit(
  acquire: () => Promise<() => void>
): Promise<() => void> {
  const lifetime = new InferenceSettlement<() => void>(inferenceOptions());
  if (lifetime.startNative())
    void acquire().then(
      (release) => {
        lifetime.nativeSettled({ ok: true, value: release });
        if (!lifetime.publish()) release();
      },
      (cause: unknown) => {
        lifetime.nativeSettled({
          ok: false,
          error: {
            code: "INFERENCE_FAILED",
            message: "Request admission failed",
            retryable: false,
            cause,
          },
        });
        lifetime.publish();
      }
    );
  const result = await lifetime.completion;
  if (!result.ok)
    throw new DOMException(
      result.error.message,
      result.error.code === "TIMEOUT" ? "TimeoutError" : "AbortError"
    );
  return result.value;
}
