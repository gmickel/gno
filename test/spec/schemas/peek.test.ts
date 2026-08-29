import { beforeAll, describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

const initializedSnapshot = {
  schemaVersion: "peek@1.0",
  gnoVersion: "1.35.0",
  generatedAt: "2026-08-29T09:00:05Z",
  initialized: true,
  indexName: "default",
  counts: { documents: 1234, collections: 5 },
  backlog: { pending: 0, failed: 0 },
  lastIndexedAt: "2026-08-29T09:00:00Z",
  recent: [
    {
      docid: "#abc123",
      uri: "gno://notes/inbox.md",
      title: "Inbox",
      collection: "notes",
      absPath: "/home/user/notes/inbox.md",
      modifiedAt: "2026-08-29T08:55:00Z",
    },
  ],
  serve: { running: true, url: "http://localhost:3000" },
} as const;

const uninitializedSnapshot = {
  schemaVersion: "peek@1.0",
  gnoVersion: "1.35.0",
  generatedAt: "2026-08-29T09:00:05Z",
  initialized: false,
  indexName: "default",
  counts: null,
  backlog: null,
  lastIndexedAt: null,
  recent: [],
  serve: { running: false, url: null },
} as const;

describe("peek schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("peek");
  });

  test("validates an initialized snapshot", () => {
    expect(assertValid(initializedSnapshot, schema)).toBe(true);
  });

  test("validates initialized:false with pinned nulls", () => {
    expect(assertValid(uninitializedSnapshot, schema)).toBe(true);
  });

  test("validates serve down on an initialized store", () => {
    expect(
      assertValid(
        {
          ...initializedSnapshot,
          serve: { running: false, url: null },
        },
        schema
      )
    ).toBe(true);
  });

  test("rejects extra fields", () => {
    expect(assertInvalid({ ...initializedSnapshot, extra: true }, schema)).toBe(
      true
    );
  });

  test("rejects half-filled uninitialized counts", () => {
    expect(
      assertInvalid(
        { ...uninitializedSnapshot, counts: { documents: 0, collections: 0 } },
        schema
      )
    ).toBe(true);
  });

  test("rejects initialized snapshot with null counts", () => {
    expect(
      assertInvalid({ ...initializedSnapshot, counts: null }, schema)
    ).toBe(true);
  });

  test("rejects store docid without a leading hash", () => {
    expect(
      assertInvalid(
        {
          ...initializedSnapshot,
          recent: [
            {
              ...initializedSnapshot.recent[0],
              docid: "abc123",
            },
          ],
        },
        schema
      )
    ).toBe(true);
  });
});
