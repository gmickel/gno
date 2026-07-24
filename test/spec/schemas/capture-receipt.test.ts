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

const browserClipProvenance = {
  schemaVersion: "1.0",
  mode: "selection",
  sourceUrl: "https://example.com/article",
  canonicalUrl: "https://example.com/article",
  title: "Example",
  author: null,
  site: "Example",
  publishedAt: "2026-07-23",
  observedAt: "2026-07-24T08:00:00.000Z",
  capturedAt: "2026-07-24T08:01:00.000Z",
  extractionHash: "1".repeat(64),
  finalBodyHash: "2".repeat(64),
  clipIdentity: "3".repeat(64),
  previewDigest: "4".repeat(64),
  exactSelection: "Exact selection",
  extractionWarnings: ["edited_content"],
  browser: {
    name: "Chromium",
    version: "140",
    platform: "macOS",
  },
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

  test("validates browser provenance and explicit provenance conflict", () => {
    expect(
      assertValid(
        {
          ...VALID_RECEIPT,
          created: false,
          openedExisting: false,
          collisionPolicyResult: "conflict",
          source: {
            ...VALID_RECEIPT.source,
            canonicalUrl: "https://example.com/article",
            site: "Example",
            publishedAt: "2026-07-23",
            browserClip: browserClipProvenance,
          },
        },
        schema
      )
    ).toBeTrue();
  });

  test("rejects malformed browser provenance without affecting legacy receipts", () => {
    expect(assertValid(VALID_RECEIPT, schema)).toBeTrue();
    expect(
      assertInvalid(
        {
          ...VALID_RECEIPT,
          source: {
            ...VALID_RECEIPT.source,
            browserClip: {
              ...browserClipProvenance,
              extractionHash: "not-a-hash",
            },
          },
        },
        schema
      )
    ).toBeTrue();
    expect(
      assertInvalid(
        {
          ...VALID_RECEIPT,
          source: {
            ...VALID_RECEIPT.source,
            browserClip: {
              ...browserClipProvenance,
              mode: "reader",
            },
          },
        },
        schema
      )
    ).toBeTrue();
  });
});
