import { beforeAll, describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

describe("mcp-capture-result schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("mcp-capture-result");
  });

  test("valid capture result", () => {
    const result = {
      docid: "#abc123",
      uri: "gno://notes/test.md",
      absPath: "/tmp/test.md",
      collection: "notes",
      relPath: "test.md",
      created: true,
      overwritten: false,
      serverInstanceId: "550e8400-e29b-41d4-a716-446655440000",
    };
    expect(assertValid(result, schema)).toBe(true);
  });

  test("rejects missing uri", () => {
    const result = {
      docid: "#abc123",
      absPath: "/tmp/test.md",
      collection: "notes",
      relPath: "test.md",
      created: true,
      overwritten: false,
      serverInstanceId: "550e8400-e29b-41d4-a716-446655440000",
    };
    expect(assertInvalid(result, schema)).toBe(true);
  });
});
