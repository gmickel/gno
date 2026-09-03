import { beforeAll, describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

const change = {
  id: "gno-change-v1.7",
  kind: "create",
  collection: "notes",
  observedAt: "2026-09-03T12:00:00.000Z",
  previous: null,
  current: {
    relPath: "plan.md",
    docid: "#abcdef12",
    uri: "gno://notes/plan.md",
    sourceHash: "a".repeat(64),
    mirrorHash: "b".repeat(64),
    active: true,
  },
  structureDelta: {
    headings: { added: ["# Plan"], removed: [] },
    links: { added: [], removed: [] },
    typedEdges: { added: [], removed: [] },
    dates: { added: [], removed: [], changed: [] },
    truncated: false,
  },
};

describe("changes follow event schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("changes-follow-event");
  });

  test("validates an event line carrying the post-apply cursor", () => {
    expect(
      assertValid({ event: change, postCursor: "gno-change-v1.7" }, schema)
    ).toBe(true);
  });

  test("validates the terminal cursor-expiry line", () => {
    expect(
      assertValid(
        {
          error: "cursor_expired",
          earliestCursor: "gno-change-v1.40",
          latestCursor: "gno-change-v1.52",
        },
        schema
      )
    ).toBe(true);
  });

  test.each([
    ["event without postCursor", { event: change }],
    ["postCursor without event", { postCursor: "gno-change-v1.7" }],
    [
      "event line with page metadata",
      { event: change, postCursor: "gno-change-v1.7", nextCursor: null },
    ],
    [
      "expiry line missing latestCursor",
      { error: "cursor_expired", earliestCursor: "gno-change-v1.40" },
    ],
    [
      "unknown error kind",
      {
        error: "journal_unavailable",
        earliestCursor: "gno-change-v1.40",
        latestCursor: "gno-change-v1.52",
      },
    ],
  ])("rejects %s", (_label, line) => {
    expect(assertInvalid(line, schema)).toBe(true);
  });
});
