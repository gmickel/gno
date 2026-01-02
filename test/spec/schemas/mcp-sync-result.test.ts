import { beforeAll, describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

describe("mcp-sync-result schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("mcp-sync-result");
  });

  test("valid sync result", () => {
    const result = {
      jobId: "job-456",
      collections: ["notes", "work"],
      status: "started",
      options: {
        gitPull: false,
        runUpdateCmd: false,
      },
    };
    expect(assertValid(result, schema)).toBe(true);
  });

  test("rejects missing options", () => {
    const result = {
      jobId: "job-456",
      collections: ["notes"],
      status: "started",
    };
    expect(assertInvalid(result, schema)).toBe(true);
  });
});
