import { beforeAll, describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

describe("mcp-remove-result schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("mcp-remove-result");
  });

  test("valid remove result", () => {
    const result = {
      removed: true,
      collection: "notes",
      configUpdated: true,
      indexedDataRetained: true,
      note: "Documents remain in index until next full reindex or manual cleanup",
    };
    expect(assertValid(result, schema)).toBe(true);
  });

  test("rejects removed false", () => {
    const result = {
      removed: false,
      collection: "notes",
      configUpdated: true,
      indexedDataRetained: true,
      note: "Documents remain",
    };
    expect(assertInvalid(result, schema)).toBe(true);
  });
});
