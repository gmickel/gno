import { beforeAll, describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

const VALID_RECEIPT = {
  uri: "gno://notes/inbox/2026-06-04/capture-abc123.md",
  docid: "#abc123",
  collection: "notes",
  relPath: "inbox/2026-06-04/capture-abc123.md",
  absPath: "/tmp/notes/inbox/2026-06-04/capture-abc123.md",
  created: true,
  openedExisting: false,
  createdWithSuffix: false,
  overwritten: false,
  contentHash:
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  source: {
    kind: "web",
    url: "https://example.com/article",
    capturedAt: "2026-06-04T12:34:56.000Z",
  },
  tags: ["inbox"],
  sync: {
    status: "completed",
  },
  embed: {
    status: "not_requested",
    reason: "Capture does not embed automatically.",
  },
  collisionPolicyResult: "created",
};

describe("capture-receipt schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("capture-receipt");
  });

  test("valid capture receipt", () => {
    expect(assertValid(VALID_RECEIPT, schema)).toBe(true);
  });

  test("rejects missing source", () => {
    const { source: _source, ...receipt } = VALID_RECEIPT;
    expect(assertInvalid(receipt, schema)).toBe(true);
  });

  test("rejects unknown status vocabulary", () => {
    expect(
      assertInvalid(
        {
          ...VALID_RECEIPT,
          sync: { status: "done" },
        },
        schema
      )
    ).toBe(true);
  });
});
