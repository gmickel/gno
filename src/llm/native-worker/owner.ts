import type { InferenceSettlement } from "../inference-cancellation";
import type { LlmResult } from "../types";
import type {
  NativeRequest,
  NativeResponse,
  NativeRequestLedger,
  NativeFrameDecoder,
} from "./protocol";

import { NativeWorkerError } from "./errors";
import { NATIVE_QUEUE_LIMIT } from "./protocol";
import { wireError } from "./runtime-config";

export function wireResult(
  result: LlmResult<Extract<NativeResponse["result"], { ok: true }>["value"]>
): NativeResponse["result"] {
  return result.ok ? result : { ok: false, error: wireError(result.error) };
}

type Child = ReturnType<typeof Bun.spawn>;
export interface Pending {
  request: NativeRequest;
  settlement: InferenceSettlement<
    Extract<NativeResponse["result"], { ok: true }>["value"]
  >;
  resolve(value: NativeResponse["result"]): void;
  executionStarted?: boolean;
  loadDeadline?: number;
  cancelTimer?: ReturnType<typeof setTimeout>;
}
export interface Owner {
  generation: number;
  child: Child;
  ledger: NativeRequestLedger;
  decoder: NativeFrameDecoder;
  pending: Pending[];
  ready: boolean;
  busy: boolean;
  quarantined: boolean;
  waiters: Set<() => void>;
  retiring: boolean;
  timer?: ReturnType<typeof setTimeout>;
  retirement?: Promise<void>;
  drain: Set<() => void>;
}
export function cancelPending(
  owner: Owner,
  pending: Pending,
  fail: (owner: Owner, error: NativeWorkerError) => void,
  sendNext: (owner: Owner) => void
): void {
  const index = owner.pending.indexOf(pending);
  if (index < 0 || owner.retiring) return;
  if (index === 0 && owner.busy) {
    owner.quarantined = true;
    clearTimeout(owner.timer);
    try {
      owner.child.send({
        version: 1,
        generation: owner.generation,
        requestId: pending.request.requestId,
        cancel:
          pending.settlement.signal.reason?.name === "TimeoutError"
            ? "timeout"
            : "abort",
      });
    } catch {
      fail(owner, new NativeWorkerError("exited"));
      return;
    }
    // This owner runs exactly one native operation. Quarantine it until that
    // operation settles; after grace, only this owned child may be retired.
    pending.cancelTimer = setTimeout(
      () => fail(owner, new NativeWorkerError("timeout")),
      5000
    );
  } else {
    owner.pending.splice(index, 1);
    owner.ledger.cancelQueued(pending.request.requestId);
    void pending.settlement.completion.then((result) =>
      pending.resolve(wireResult(result))
    );
    if (!owner.busy) {
      if (!owner.pending.length) {
        for (const resolve of owner.drain) resolve();
        owner.drain.clear();
      }
      sendNext(owner);
    }
  }
}

/** Admission remains bounded while a canceled owner cannot accept new work. */
export function waitForQuarantine(
  owner: Owner,
  settlement: Pending["settlement"]
): Promise<void> {
  if (owner.ledger.size + owner.waiters.size >= NATIVE_QUEUE_LIMIT + 1)
    throw new NativeWorkerError("overloaded");
  return new Promise((resolve) => {
    const finish = () => {
      owner.waiters.delete(finish);
      settlement.signal.removeEventListener("abort", finish);
      resolve();
    };
    owner.waiters.add(finish);
    settlement.signal.addEventListener("abort", finish, { once: true });
    if (settlement.signal.aborted) finish();
  });
}
export function releaseQuarantine(owner: Owner): void {
  owner.quarantined = false;
  for (const finish of owner.waiters) finish();
}
