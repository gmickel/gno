/**
 * Streaming read path over the document change journal for
 * `gno changes --follow --jsonl`.
 *
 * Wire contract (spec/cli.md "gno changes"): one JSON object per line. Event
 * lines are `{event, postCursor}` where `postCursor` is the journal cursor
 * after that event was applied; a consumer that persists `postCursor` and
 * resumes with `--cursor <postCursor>` sees nothing before it again. Quiet
 * periods emit nothing. When the resume cursor falls below the retention
 * floor, exactly one terminal `{error: "cursor_expired", earliestCursor,
 * latestCursor}` line is written and the loop returns `expired`.
 */

import type { KnowledgeChange } from "../../core/knowledge-delta";
import type { StorePort } from "../../store/types";

import {
  decodeDocumentChangeCursor,
  encodeDocumentChangeCursor,
} from "../../core/change-journal";
import { projectKnowledgeChange } from "../../core/knowledge-delta";

/** Poll cadence between empty journal reads; pages drain back-to-back. */
export const FOLLOW_POLL_INTERVAL_MS = 250;
const FOLLOW_PAGE_SIZE = 500;

export interface ChangesFollowEvent {
  event: KnowledgeChange;
  postCursor: string;
}

export interface ChangesFollowExpired {
  error: "cursor_expired";
  earliestCursor: string;
  latestCursor: string;
}

export type ChangesFollowLine = ChangesFollowEvent | ChangesFollowExpired;

export interface FollowChangesOptions {
  /** Resume cursor; omitted means start at the journal's latest cursor. */
  cursor?: string;
  collection?: string;
  signal: AbortSignal;
  pollIntervalMs?: number;
}

export type FollowChangesResult =
  | { status: "stopped"; cursor: string }
  | { status: "expired"; earliestCursor: string; latestCursor: string }
  | { status: "error"; error: string; isValidation: boolean };

export const validateFollowCursor = (cursor: string): string | null => {
  try {
    decodeDocumentChangeCursor(cursor);
    return null;
  } catch {
    return "cursor must be an opaque change cursor from an earlier response";
  }
};

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

/** Sequence behind an opaque cursor, or `null` when it does not decode. */
const cursorSequence = (cursor: string): number | null => {
  try {
    return decodeDocumentChangeCursor(cursor);
  } catch {
    return null;
  }
};

/**
 * Later of two opaque cursors. Each side is decoded on its own: a malformed
 * side yields the other, and when both are malformed `left` wins.
 */
const maxCursor = (left: string, right: string): string => {
  const leftSequence = cursorSequence(left);
  const rightSequence = cursorSequence(right);
  if (leftSequence === null) return rightSequence === null ? left : right;
  if (rightSequence === null) return left;
  return encodeDocumentChangeCursor(Math.max(leftSequence, rightSequence));
};

/**
 * Stream journal events to `emit` until the signal aborts, the cursor
 * expires, or the store fails. Each event line is emitted after the cursor
 * it carries is final, so the caller can checkpoint per line.
 */
export async function followChanges(
  store: StorePort,
  options: FollowChangesOptions,
  emit: (line: ChangesFollowLine) => void
): Promise<FollowChangesResult> {
  const { signal } = options;
  const pollIntervalMs = options.pollIntervalMs ?? FOLLOW_POLL_INTERVAL_MS;
  let cursor = options.cursor;

  if (cursor === undefined) {
    const head = await store.listDocumentChanges({ limit: 1 });
    if (!head.ok) {
      return {
        status: "error",
        error: head.error.message,
        isValidation: false,
      };
    }
    cursor = head.value.latestCursor;
  }

  while (!signal.aborted) {
    const page = await store.listDocumentChanges({
      cursor,
      collection: options.collection,
      limit: FOLLOW_PAGE_SIZE,
    });
    if (!page.ok) {
      return {
        status: "error",
        error: page.error.message,
        isValidation: page.error.code === "INVALID_INPUT",
      };
    }
    if (page.value.cursorExpired) {
      const { earliestCursor, latestCursor } = page.value;
      emit({ error: "cursor_expired", earliestCursor, latestCursor });
      return { status: "expired", earliestCursor, latestCursor };
    }
    let drained = true;
    for (const row of page.value.changes) {
      if (signal.aborted) {
        drained = false;
        break;
      }
      const event = projectKnowledgeChange(row);
      // The change id encodes the sequence that produced it, which is exactly
      // the journal position after applying the event.
      cursor = event.id;
      emit({ event, postCursor: cursor });
    }
    if (page.value.truncated) continue;
    // An untruncated page was scanned to the journal head even when a
    // collection filter emitted nothing from it: advance to that high-water
    // mark so the next poll does not rescan the same tail. Emitted events keep
    // their own postCursor; this only moves the internal resume point.
    if (drained) {
      cursor = maxCursor(cursor, page.value.latestCursor);
    }
    await sleep(pollIntervalMs, signal);
  }
  return { status: "stopped", cursor };
}
