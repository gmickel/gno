import { beforeAll, describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

describe("collection-list schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("collection-list");
  });

  test("declares and validates updateCmdTimeoutMs", () => {
    const declared = (
      schema as { items: { properties: Record<string, unknown> } }
    ).items.properties;
    expect(declared.updateCmdTimeoutMs).toBeDefined();
    const list = [
      {
        name: "wiki",
        path: "/home/user/wiki",
        pattern: "**/*.md",
        include: [],
        exclude: [],
        updateCmd: "git pull",
        updateCmdTimeoutMs: 120_000,
      },
    ];
    expect(assertValid(list, schema)).toBe(true);
  });

  test("rejects a non-positive updateCmdTimeoutMs", () => {
    const list = [
      {
        name: "wiki",
        pattern: "**/*.md",
        include: [],
        exclude: [],
        updateCmdTimeoutMs: 0,
      },
    ];
    expect(assertInvalid(list, schema)).toBe(true);
  });
});
