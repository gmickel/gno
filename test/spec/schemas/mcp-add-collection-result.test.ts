import { beforeAll, describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

describe("mcp-add-collection-result schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("mcp-add-collection-result");
  });

  test("valid add collection result", () => {
    const result = {
      jobId: "job-123",
      collection: "notes",
      status: "started",
    };
    expect(assertValid(result, schema)).toBe(true);
  });

  test("rejects missing jobId", () => {
    const result = {
      collection: "notes",
      status: "started",
    };
    expect(assertInvalid(result, schema)).toBe(true);
  });
});
