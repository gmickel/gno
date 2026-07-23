/** Bounded, coalescing resident scheduler for evidence-triggered reverification. */

import type {
  SavedCapsuleRegistrationRecord,
  StorePort,
  StoreResult,
} from "../store/types";
import type {
  SavedCapsuleReverificationDeps,
  SavedCapsuleReverificationOutcome,
} from "./capsule-reverification";

import { SavedCapsuleRegistryError } from "./capsule-registry";
import { reverifySavedCapsule } from "./capsule-reverification";
import {
  decodeDocumentChangeCursor,
  encodeDocumentChangeCursor,
} from "./change-journal";

const MAX_REGISTRATIONS_PER_DRAIN = 10_000;

type SchedulerStore = StorePort &
  Pick<
    StorePort,
    | "getSavedCapsuleReverificationState"
    | "listDocumentChanges"
    | "listSavedCapsuleIdsAffectedByChanges"
    | "listSavedCapsuleRegistrations"
    | "setSavedCapsuleReverificationSequence"
  >;

export interface SavedCapsuleReverificationDrain {
  fromSequence: number;
  throughSequence: number;
  cursorExpired: boolean;
  affected: number;
  completed: number;
  failed: number;
}

export interface SavedCapsuleReverificationSchedulerOptions {
  deps: Omit<SavedCapsuleReverificationDeps, "store"> & {
    store: SchedulerStore & SavedCapsuleReverificationDeps["store"];
  };
  startBackgroundWork: (
    operation: (signal: AbortSignal) => Promise<void>
  ) => boolean;
  onDrain?: (result: SavedCapsuleReverificationDrain) => void;
}

const unwrapStore = <T>(result: StoreResult<T>, operation: string): T => {
  if (result.ok) return result.value;
  throw new SavedCapsuleRegistryError(
    "store_failed",
    `${operation}: ${result.error.message}`,
    result.error.cause
  );
};

export class SavedCapsuleReverificationScheduler {
  readonly #options: SavedCapsuleReverificationSchedulerOptions;
  #pending = false;
  #running = false;
  #disposed = false;

  constructor(options: SavedCapsuleReverificationSchedulerOptions) {
    this.#options = options;
  }

  notifySyncSettled(): void {
    if (this.#disposed) return;
    this.#pending = true;
    if (this.#running) return;
    this.#running = true;
    const started = this.#options.startBackgroundWork(async (signal) => {
      await this.#run(signal);
    });
    if (!started) {
      this.#running = false;
    }
  }

  async triggerNow(signal: AbortSignal = new AbortController().signal) {
    if (this.#disposed) return [];
    const results: SavedCapsuleReverificationDrain[] = [];
    do {
      this.#pending = false;
      results.push(await this.#drain(signal));
    } while (this.#pending && !signal.aborted && !this.#disposed);
    return results;
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await Promise.resolve();
  }

  async #run(signal: AbortSignal): Promise<void> {
    const operation = (async () => {
      try {
        while (this.#pending && !signal.aborted && !this.#disposed) {
          this.#pending = false;
          const result = await this.#drain(signal);
          this.#options.onDrain?.(result);
        }
      } finally {
        this.#running = false;
        if (this.#pending && !this.#disposed) {
          this.notifySyncSettled();
        }
      }
    })();
    await operation;
  }

  async #drain(signal: AbortSignal): Promise<SavedCapsuleReverificationDrain> {
    const store = this.#options.deps.store;
    const schedulerState = unwrapStore(
      await store.getSavedCapsuleReverificationState(),
      "Failed to read saved Capsule scheduler state"
    );
    const fromSequence = schedulerState.lastProcessedSequence;
    const journal = unwrapStore(
      await store.listDocumentChanges({
        cursor: encodeDocumentChangeCursor(fromSequence),
        limit: 1,
      }),
      "Failed to read document change journal"
    );
    const throughSequence = decodeDocumentChangeCursor(journal.latestCursor);
    if (throughSequence <= fromSequence) {
      return {
        fromSequence,
        throughSequence,
        cursorExpired: journal.cursorExpired,
        affected: 0,
        completed: 0,
        failed: 0,
      };
    }

    let registrations: SavedCapsuleRegistrationRecord[];
    if (journal.cursorExpired) {
      registrations = unwrapStore(
        await store.listSavedCapsuleRegistrations(),
        "Failed to list saved Context Capsules"
      );
      if (registrations.length > MAX_REGISTRATIONS_PER_DRAIN) {
        throw new SavedCapsuleRegistryError(
          "store_failed",
          "Saved Capsule scheduler registration bound exceeded"
        );
      }
    } else {
      const affected = unwrapStore(
        await store.listSavedCapsuleIdsAffectedByChanges(
          fromSequence,
          throughSequence,
          MAX_REGISTRATIONS_PER_DRAIN
        ),
        "Failed to resolve changed saved Capsule evidence"
      );
      if (affected.truncated) {
        throw new SavedCapsuleRegistryError(
          "store_failed",
          "Saved Capsule scheduler registration bound exceeded"
        );
      }
      const all = unwrapStore(
        await store.listSavedCapsuleRegistrations(),
        "Failed to list saved Context Capsules"
      );
      const ids = new Set(affected.registrationIds);
      registrations = all.filter((registration) =>
        ids.has(registration.registrationId)
      );
    }

    const outcomes: SavedCapsuleReverificationOutcome[] = [];
    for (const registration of registrations) {
      if (signal.aborted) break;
      if (registration.lastAttemptedSequence >= throughSequence) continue;
      outcomes.push(
        await reverifySavedCapsule(
          registration.registrationId,
          {
            kind: "journal",
            fromSequence,
            throughSequence,
          },
          this.#options.deps
        )
      );
    }
    if (!signal.aborted) {
      const advanced = unwrapStore(
        await store.setSavedCapsuleReverificationSequence(
          throughSequence,
          schedulerState.registrationEpoch
        ),
        "Failed to advance saved Capsule scheduler state"
      );
      if (!advanced) this.#pending = true;
    }
    return {
      fromSequence,
      throughSequence,
      cursorExpired: journal.cursorExpired,
      affected: outcomes.length,
      completed: outcomes.filter(
        (outcome) => outcome.verification.operationStatus === "completed"
      ).length,
      failed: outcomes.filter(
        (outcome) => outcome.verification.operationStatus === "failed"
      ).length,
    };
  }
}
