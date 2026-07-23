/** Tracks cancellable work that intentionally outlives its initiating request. */

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
      .then(() => operation(controller.signal))
      .catch(() => undefined)
      .finally(() => this.#entries.delete(entry));
    this.#entries.add(entry);
    return true;
  }

  async cancelAndDrain(): Promise<void> {
    for (const entry of this.#entries) {
      entry.controller.abort(new Error("Resident runtime is shutting down"));
    }
    await Promise.allSettled(
      Array.from(this.#entries, (entry) => entry.promise)
    );
  }
}
