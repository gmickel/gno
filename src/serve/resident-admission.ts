/** Resident request admission and bounded reader concurrency primitives. */

import type { ResidentRequestHandle } from "./resident-runtime";

import { settlesBy } from "../core/shutdown-budget";

const DEFAULT_READER_LIMIT = 8;
const DEFAULT_READER_QUEUE_LIMIT = 64;

export class ReaderGate {
  readonly #limit: number;
  readonly #maxQueued: number;
  #active = 0;
  readonly #queue: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  constructor(
    limit = DEFAULT_READER_LIMIT,
    maxQueued = DEFAULT_READER_QUEUE_LIMIT
  ) {
    this.#limit = Math.max(1, Math.floor(limit));
    this.#maxQueued = Math.max(0, Math.floor(maxQueued));
  }

  get active(): number {
    return this.#active;
  }

  get queued(): number {
    return this.#queue.length;
  }

  get limit(): number {
    return this.#limit;
  }

  get maxQueued(): number {
    return this.#maxQueued;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw new Error("Resident request aborted");
    }
    if (this.#active >= this.#limit) {
      if (this.#queue.length >= this.#maxQueued) {
        throw new Error("Resident reader queue is full");
      }
      await new Promise<void>((resolve, reject) => {
        const entry = {
          resolve,
          reject,
          signal,
          onAbort: undefined as (() => void) | undefined,
        };
        entry.onAbort = () => {
          const index = this.#queue.indexOf(entry);
          if (index >= 0) this.#queue.splice(index, 1);
          reject(new Error("Resident request aborted"));
        };
        signal?.addEventListener("abort", entry.onAbort, { once: true });
        this.#queue.push(entry);
      });
      // Release reserved capacity if cancellation won the handoff race.
      if (signal?.aborted) {
        this.#releaseSlot();
        throw new Error("Resident request aborted");
      }
    } else {
      this.#active += 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#releaseSlot();
    };
  }

  #releaseSlot(): void {
    const next = this.#queue.shift();
    if (next) {
      // Transfer ownership synchronously, before any fresh acquire can run.
      next.signal?.removeEventListener("abort", next.onAbort!);
      next.resolve();
    } else {
      this.#active -= 1;
    }
  }
}

export class AdmissionController {
  #accepting = true;
  readonly #requests = new Map<string, AbortController>();
  readonly #drainWaiters = new Set<() => void>();

  get active(): number {
    return this.#requests.size;
  }

  get accepting(): boolean {
    return this.#accepting;
  }

  admit(parentSignal?: AbortSignal): ResidentRequestHandle | null {
    if (!this.#accepting) return null;
    const id = crypto.randomUUID();
    const controller = new AbortController();
    const abortFromParent = (): void => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    if (parentSignal?.aborted) abortFromParent();
    this.#requests.set(id, controller);
    let finished = false;
    return {
      id,
      signal: controller.signal,
      finish: () => {
        if (finished) return;
        finished = true;
        parentSignal?.removeEventListener("abort", abortFromParent);
        this.#requests.delete(id);
        if (this.#requests.size === 0) {
          for (const waiter of this.#drainWaiters) waiter();
          this.#drainWaiters.clear();
        }
      },
    };
  }

  async closeAndDrain(
    deadlineMs: number,
    abortSettleMs = deadlineMs
  ): Promise<boolean> {
    this.stop();
    const deadline = performance.now() + deadlineMs;
    if (await settlesBy(this.drain(), deadline)) return false;
    this.cancel();
    await settlesBy(this.drain(), deadline + abortSettleMs);
    return true;
  }

  stop(): void {
    this.#accepting = false;
  }

  cancel(): void {
    for (const controller of this.#requests.values())
      controller.abort(new Error("Resident runtime is shutting down"));
  }

  drain(): Promise<void> {
    if (!this.#requests.size) return Promise.resolve();
    return new Promise<void>((resolve) => this.#drainWaiters.add(resolve));
  }
}
