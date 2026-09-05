/** Tracks cancellable work that intentionally outlives its initiating request. */
import {
  withBackgroundInference,
  withOwnedInferenceScope,
} from "../llm/inference-scope";

interface BackgroundWorkEntry {
  controller: AbortController;
  promise: Promise<void>;
}

export class ResidentBackgroundWork {
  readonly #entries = new Set<BackgroundWorkEntry>();
  readonly #isAccepting: () => boolean;

  constructor(isAccepting: () => boolean) {
    this.#isAccepting = isAccepting;
  }

  start(operation: (signal: AbortSignal) => Promise<void>): boolean {
    if (!this.#isAccepting()) return false;
    const controller = new AbortController();
    const entry: BackgroundWorkEntry = {
      controller,
      promise: Promise.resolve(),
    };
    entry.promise = Promise.resolve()
      .then(() =>
        withBackgroundInference(() =>
          withOwnedInferenceScope({ signal: controller.signal }, () =>
            operation(controller.signal)
          )
        )
      )
      .catch(() => undefined)
      .finally(() => this.#entries.delete(entry));
    this.#entries.add(entry);
    return true;
  }

  cancel(): void {
    for (const entry of this.#entries) {
      entry.controller.abort(new Error("Resident runtime is shutting down"));
    }
  }

  async drain(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.#entries, (entry) => entry.promise)
    );
  }

  async cancelAndDrain(): Promise<void> {
    this.cancel();
    await this.drain();
  }
}
