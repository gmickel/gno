import type { InferenceOptions } from "../types";

export interface NativeEvaluationOptions extends InferenceOptions {
  /** Child control receipt immediately before the first actual evaluation. */
  onExecutionStart?: () => void;
}

export function checkEvaluation(options?: NativeEvaluationOptions): void {
  options?.signal?.throwIfAborted();
  if (options?.deadlineAt !== undefined && Date.now() >= options.deadlineAt)
    throw new DOMException("Inference deadline exceeded", "TimeoutError");
}
export function startEvaluation(options?: NativeEvaluationOptions): void {
  checkEvaluation(options);
  options?.onExecutionStart?.();
}
