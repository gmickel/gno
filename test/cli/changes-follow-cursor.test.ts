/**
 * `followChanges` cursor bookkeeping with a collection filter: an all-filtered
 * page still advances the internal resume point to the scanned high-water
 * mark, so the follower does not rescan the journal tail on every poll.
 * Emitted events keep the postCursor-per-event contract.
 *
 * @module test/cli/changes-follow-cursor
 */

import { describe, expect, test } from "bun:test";

import type { DocumentChangeListOptions } from "../../src/store/types";
import type { StorePort } from "../../src/store/types";

import { followChanges } from "../../src/cli/commands/changes-follow";
import { encodeDocumentChangeCursor } from "../../src/core/change-journal";

const cursorAt = encodeDocumentChangeCursor;

const fakeStore = (
  pages: ((options: DocumentChangeListOptions) => {
    changes: never[];
    latestCursor: string;
    truncated: boolean;
  })[]
): { store: StorePort; calls: DocumentChangeListOptions[] } => {
  const calls: DocumentChangeListOptions[] = [];
  const store = {
    listDocumentChanges: async (options: DocumentChangeListOptions = {}) => {
      calls.push(options);
      const page = pages[Math.min(calls.length - 1, pages.length - 1)]!;
      const { changes, latestCursor, truncated } = page(options);
      return {
        ok: true as const,
        value: {
          changes,
          nextCursor: null,
          earliestCursor: cursorAt(0),
          latestCursor,
          cursorExpired: false,
          truncated,
        },
      };
    },
  } as unknown as StorePort;
  return { store, calls };
};

describe("followChanges cursor advance under a collection filter", () => {
  test("an all-filtered page moves the resume cursor to the journal head without emitting", async () => {
    // Journal head is at 10; the follower resumes from 3 with a filter that
    // matches nothing, so every page is empty.
    const { store, calls } = fakeStore([
      () => ({ changes: [], latestCursor: cursorAt(10), truncated: false }),
    ]);
    const controller = new AbortController();
    const emitted: unknown[] = [];
    const run = followChanges(
      store,
      {
        cursor: cursorAt(3),
        collection: "other",
        signal: controller.signal,
        pollIntervalMs: 5,
      },
      (line) => emitted.push(line)
    );
    while (calls.length < 3) {
      await Bun.sleep(2);
    }
    controller.abort();
    const result = await run;

    expect(emitted).toEqual([]);
    expect(calls[0]?.cursor).toBe(cursorAt(3));
    // Second and later polls start at the scanned high-water mark.
    expect(calls[1]?.cursor).toBe(cursorAt(10));
    expect(calls[2]?.cursor).toBe(cursorAt(10));
    expect(calls.every((call) => call.collection === "other")).toBe(true);
    expect(result).toEqual({ status: "stopped", cursor: cursorAt(10) });
  });

  test("the cursor never moves backwards when the head is behind the resume point", async () => {
    const { store, calls } = fakeStore([
      () => ({ changes: [], latestCursor: cursorAt(4), truncated: false }),
    ]);
    const controller = new AbortController();
    const run = followChanges(
      store,
      {
        cursor: cursorAt(7),
        collection: "other",
        signal: controller.signal,
        pollIntervalMs: 5,
      },
      () => undefined
    );
    while (calls.length < 2) {
      await Bun.sleep(2);
    }
    controller.abort();
    const result = await run;
    expect(calls[1]?.cursor).toBe(cursorAt(7));
    expect(result).toEqual({ status: "stopped", cursor: cursorAt(7) });
  });

  // `maxCursor` decodes each side on its own: a malformed side yields the
  // other, and only when both are malformed does the resume cursor win.
  test.each([
    [
      "a malformed head keeps the resume cursor",
      cursorAt(7),
      "not-a-cursor",
      cursorAt(7),
    ],
    [
      "a malformed resume cursor adopts the head",
      "not-a-cursor",
      cursorAt(10),
      cursorAt(10),
    ],
    [
      "two malformed cursors keep the resume cursor",
      "left-garbage",
      "right-garbage",
      "left-garbage",
    ],
  ])("%s", async (_label, resume, head, expected) => {
    const { store, calls } = fakeStore([
      () => ({ changes: [], latestCursor: head, truncated: false }),
    ]);
    const controller = new AbortController();
    const run = followChanges(
      store,
      {
        cursor: resume,
        collection: "other",
        signal: controller.signal,
        pollIntervalMs: 5,
      },
      () => undefined
    );
    while (calls.length < 2) {
      await Bun.sleep(2);
    }
    controller.abort();
    const result = await run;
    expect(calls[1]?.cursor).toBe(expected);
    expect(result).toEqual({ status: "stopped", cursor: expected });
  });
});
