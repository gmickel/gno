import { describe, expect, test } from "bun:test";

import {
  decodeDocumentChangeCursor,
  encodeDocumentChangeCursor,
} from "../../src/core/change-journal";

describe("document change cursors", () => {
  test("round-trips an opaque monotonic position", () => {
    const cursor = encodeDocumentChangeCursor(42);
    expect(cursor).not.toContain("42");
    expect(decodeDocumentChangeCursor(cursor)).toBe(42);
  });

  test("rejects malformed and negative positions", () => {
    expect(() => decodeDocumentChangeCursor("42")).toThrow(
      "Invalid document change cursor"
    );
    expect(() => encodeDocumentChangeCursor(-1)).toThrow(
      "must be non-negative"
    );
  });
});
