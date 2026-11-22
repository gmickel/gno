import type {
  RecordAdapter,
  RecordAdapterFailure,
  RecordAdapterFailureCode,
  RecordAdapterEvent,
  RecordAdapterInput,
} from "../converters/types";
import type { EgressLineage } from "../core/egress-provenance";

import {
  egressLineageSchema,
  legacyLocalOnlyEgressLineage,
} from "../core/egress-provenance";
import {
  type AccountedCanonicalRecord,
  adapterFailureMessage,
  canonicalRecord,
  type CanonicalRecord,
  normalizeRecordAdapterIdentity,
  recordKeyFor,
  recordAdapterFingerprint,
  safeFailure,
} from "./record-adapter-canonical";

export type { CanonicalRecord } from "./record-adapter-canonical";
export {
  recordAdapterFingerprint,
  recordKeyFor,
} from "./record-adapter-canonical";

export interface RecordAdapterRunResult {
  adapterId: string;
  adapterVersion: string;
  adapterFingerprint: string;
  egressLineage: EgressLineage;
  records: CanonicalRecord[];
  failures: RecordAdapterFailure[];
  failedRecordKeys: string[];
  snapshotState: "complete" | "partial";
  authoritative: boolean;
  stoppedByCap: boolean;
  sourceBytesRead: number;
}

class SourceLimitError extends Error {
  constructor() {
    super("Record adapter source exceeded its byte limit.");
    this.name = "SourceLimitError";
  }
}

const TIMEOUT = Symbol("record-adapter-timeout");

const closeIterator = async (
  iterator: AsyncIterator<unknown>
): Promise<boolean> => {
  if (!iterator.return) return true;
  try {
    await iterator.return();
    return true;
  } catch {
    return false;
  }
};

/** Consume one adapter snapshot while centrally enforcing every global cap. */
export async function runRecordAdapter(
  adapter: RecordAdapter,
  input: RecordAdapterInput,
  options: { egressLineage?: EgressLineage } = {}
): Promise<RecordAdapterRunResult> {
  const adapterIdentity = normalizeRecordAdapterIdentity(adapter);
  const adapterFingerprint = recordAdapterFingerprint(adapter);
  const precomputedAdapter = { adapterIdentity, adapterFingerprint };
  const egressLineage = egressLineageSchema.parse(
    options.egressLineage ?? legacyLocalOnlyEgressLineage(input.collection)
  );
  const accepted = new Map<string, AccountedCanonicalRecord>();
  const seenKeys = new Set<string>();
  const failedRecordKeys = new Set<string>();
  const failures: RecordAdapterFailure[] = [];
  let totalChars = 0;
  let sourceBytesRead = 0;
  let sourceOpened = false;
  let sourceLimitExceeded = false;
  let sourceReadFailed = false;
  let stoppedByCap = false;
  let terminalCount = 0;
  let terminalState: "complete" | "partial" = "partial";
  let iteratorCloseFailed = false;
  let stoppedByFailureLimit = false;
  let timedOut = false;
  const abortController = new AbortController();
  // Single shared deadline timer for the entire container with a replaceable
  // waiter slot (avoids per-record setTimeout overhead and handler accumulation)
  // plus an absolute wall-clock check before every iterator advance so synchronous
  // adapter work exceeding timeoutMs cannot slip through microtasks.
  const timeoutMs = input.limits.timeoutMs ?? 60_000;
  const deadlineMs = Date.now() + timeoutMs;
  let deadlineExpired = timeoutMs <= 0;
  let onDeadline: (() => void) | undefined;
  const deadlineTimer = deadlineExpired
    ? undefined
    : setTimeout(() => {
        deadlineExpired = true;
        const cb = onDeadline;
        onDeadline = undefined;
        cb?.();
      }, timeoutMs);
  const nextBeforeDeadline = <T>(
    iter: AsyncIterator<T>
  ): Promise<IteratorResult<T> | typeof TIMEOUT> => {
    if (deadlineExpired || Date.now() >= deadlineMs) {
      deadlineExpired = true;
      return Promise.resolve(TIMEOUT);
    }
    return new Promise<IteratorResult<T> | typeof TIMEOUT>(
      (resolve, reject) => {
        onDeadline = () => resolve(TIMEOUT);
        void iter.next().then(
          (value) => {
            onDeadline = undefined;
            resolve(value);
          },
          (error: unknown) => {
            onDeadline = undefined;
            reject(error);
          }
        );
      }
    );
  };

  const appendFailure = (failure: RecordAdapterFailure): boolean => {
    if (stoppedByFailureLimit) return true;
    if (input.limits.maxFailures > 0) failures.push(failure);
    if (failures.length < input.limits.maxFailures) return false;
    failures.push(
      safeFailure(
        input,
        "FAILURE_LIMIT",
        "Record snapshot reached its failure limit.",
        true
      )
    );
    stoppedByFailureLimit = true;
    stoppedByCap = true;
    return true;
  };

  const boundedOpen = (): AsyncIterable<Uint8Array> => ({
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      if (sourceOpened)
        throw new Error("Record adapter source may be opened once.");
      sourceOpened = true;
      let iterator: AsyncIterator<Uint8Array>;
      try {
        iterator = input.open(abortController.signal)[Symbol.asyncIterator]();
      } catch {
        sourceReadFailed = true;
        throw new Error("Record adapter source could not be opened.");
      }
      return {
        async next() {
          let next: IteratorResult<Uint8Array>;
          try {
            next = await iterator.next();
          } catch {
            sourceReadFailed = true;
            throw new Error("Record adapter source read failed.");
          }
          if (next.done) return next;
          sourceBytesRead += next.value.byteLength;
          if (sourceBytesRead > input.limits.maxSourceBytes) {
            sourceLimitExceeded = true;
            iteratorCloseFailed ||= !(await closeIterator(iterator));
            throw new SourceLimitError();
          }
          return next;
        },
        async return() {
          iteratorCloseFailed ||= !(await closeIterator(iterator));
          return { done: true, value: undefined };
        },
      };
    },
  });

  let iterator: AsyncIterator<RecordAdapterEvent> | undefined;
  try {
    iterator = adapter
      .records({
        ...input,
        open: boundedOpen,
        signal: abortController.signal,
      })
      [Symbol.asyncIterator]();
    while (true) {
      const next = await nextBeforeDeadline(iterator);
      if (next === TIMEOUT) {
        timedOut = true;
        stoppedByCap = true;
        abortController.abort();
        failures.push(
          safeFailure(
            input,
            "TIMEOUT",
            "Record adapter exceeded its time limit.",
            true
          )
        );
        break;
      }
      if (next.done) break;
      const event = next.value;
      if (event.type === "snapshot") {
        terminalCount += 1;
        if (terminalCount === 1) terminalState = event.state;
        else {
          const reachedFailureLimit = appendFailure(
            safeFailure(
              input,
              "INVALID_SNAPSHOT",
              "Record adapter emitted more than one terminal snapshot.",
              false
            )
          );
          if (reachedFailureLimit) break;
        }
        continue;
      }
      if (terminalCount > 0) {
        const reachedFailureLimit = appendFailure(
          safeFailure(
            input,
            "INVALID_SNAPSHOT",
            "Record adapter emitted data after its terminal snapshot.",
            false
          )
        );
        if (reachedFailureLimit) break;
        continue;
      }
      if (event.type === "failure") {
        const reachedFailureLimit = appendFailure(
          safeFailure(
            input,
            event.failure.code,
            adapterFailureMessage(event.failure.code),
            event.failure.retryable,
            event.failure.stableId,
            event.failure.sourceLocator
          )
        );
        if (reachedFailureLimit) break;
      } else {
        let record: AccountedCanonicalRecord;
        try {
          record = canonicalRecord(adapter, event.record, precomputedAdapter);
        } catch (error) {
          const code: RecordAdapterFailureCode =
            error instanceof Error && error.message === "invalid source locator"
              ? "INVALID_LOCATOR"
              : error instanceof Error &&
                  error.message === "invalid source hash"
                ? "INVALID_SOURCE_HASH"
                : error instanceof Error &&
                    error.message === "record metadata out of bounds"
                  ? "RECORD_TOO_LARGE"
                  : "MISSING_ID";
          const reachedFailureLimit = appendFailure(
            safeFailure(
              input,
              code,
              "Record identity or provenance was invalid.",
              false,
              event.record.stableId
            )
          );
          if (reachedFailureLimit) break;
          continue;
        }
        if (seenKeys.has(record.recordKey)) {
          const previous = accepted.get(record.recordKey);
          if (previous) totalChars -= previous.accountingChars;
          accepted.delete(record.recordKey);
          failedRecordKeys.add(record.recordKey);
          const reachedFailureLimit = appendFailure(
            safeFailure(
              input,
              "DUPLICATE_ID",
              "Duplicate stable record identity; every duplicate was isolated.",
              false,
              record.stableId,
              record.sourceLocator
            )
          );
          if (reachedFailureLimit) break;
          continue;
        }
        seenKeys.add(record.recordKey);
        if (
          record.markdown.length > input.limits.maxRecordChars ||
          record.metadataChars > input.limits.maxMetadataChars
        ) {
          const reachedFailureLimit = appendFailure(
            safeFailure(
              input,
              "RECORD_TOO_LARGE",
              "Record exceeded the canonical character limit.",
              false,
              record.stableId,
              record.sourceLocator
            )
          );
          failedRecordKeys.add(record.recordKey);
          if (reachedFailureLimit) break;
          continue;
        }
        if (accepted.size >= input.limits.maxRecords) {
          failures.push(
            safeFailure(
              input,
              "RECORD_LIMIT",
              "Record snapshot exceeded its record limit.",
              true
            )
          );
          stoppedByCap = true;
          break;
        }
        if (totalChars + record.accountingChars > input.limits.maxTotalChars) {
          failures.push(
            safeFailure(
              input,
              "RECORD_LIMIT",
              "Record snapshot exceeded its total character limit.",
              true
            )
          );
          stoppedByCap = true;
          break;
        }
        accepted.set(record.recordKey, record);
        totalChars += record.accountingChars;
      }
    }
  } catch (error) {
    failures.push(
      safeFailure(
        input,
        error instanceof SourceLimitError
          ? "SOURCE_TOO_LARGE"
          : "ADAPTER_FAILURE",
        error instanceof SourceLimitError
          ? error.message
          : "Record adapter stopped before a terminal snapshot.",
        true
      )
    );
    stoppedByCap ||= error instanceof SourceLimitError;
  } finally {
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer);
    }
    onDeadline = undefined;
    if (iterator) {
      if (timedOut) {
        void closeIterator(iterator);
      } else {
        iteratorCloseFailed ||= !(await closeIterator(iterator));
      }
    }
  }

  if (iteratorCloseFailed) {
    failures.push(
      safeFailure(
        input,
        "ADAPTER_FAILURE",
        "Record adapter iterator did not close cleanly.",
        true
      )
    );
  }

  if (
    sourceLimitExceeded &&
    !failures.some((failure) => failure.code === "SOURCE_TOO_LARGE")
  ) {
    failures.push(
      safeFailure(
        input,
        "SOURCE_TOO_LARGE",
        "Record adapter source exceeded its byte limit.",
        true
      )
    );
    stoppedByCap = true;
  }

  if (
    sourceReadFailed &&
    !failures.some((failure) => failure.code === "ADAPTER_FAILURE")
  ) {
    failures.push(
      safeFailure(
        input,
        "ADAPTER_FAILURE",
        "Record adapter source could not be read completely.",
        true
      )
    );
  }

  if (terminalCount !== 1) {
    failures.push(
      safeFailure(
        input,
        "INVALID_SNAPSHOT",
        "Record adapter did not emit exactly one terminal snapshot.",
        true
      )
    );
  }

  const authoritative =
    terminalCount === 1 &&
    terminalState === "complete" &&
    failures.length === 0 &&
    !stoppedByCap;
  const failureLimit = Math.max(0, input.limits.maxFailures);
  const boundedFailures =
    failures.length <= failureLimit
      ? failures
      : failureLimit === 0
        ? []
        : [
            ...failures.slice(0, failureLimit - 1),
            safeFailure(
              input,
              "FAILURE_LIMIT",
              "Record snapshot reached its failure limit.",
              true
            ),
          ];
  return {
    adapterId: adapterIdentity.id,
    adapterVersion: adapterIdentity.version,
    adapterFingerprint,
    egressLineage,
    records: [...accepted.values()]
      .sort((left, right) => left.recordKey.localeCompare(right.recordKey))
      .map(
        ({
          accountingChars: _accountingChars,
          metadataChars: _metadataChars,
          ...record
        }) => record
      ),
    failures: boundedFailures,
    failedRecordKeys: [...failedRecordKeys].sort(),
    snapshotState: terminalState,
    authoritative,
    stoppedByCap,
    sourceBytesRead,
  };
}
