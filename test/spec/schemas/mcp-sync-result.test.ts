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

  test("valid queued path-level sync result", () => {
    const result = {
      jobId: "job-789",
      collections: ["notes"],
      status: "queued",
      paths: ["a.md", "sub/b.md"],
      options: {
        gitPull: false,
        runUpdateCmd: false,
      },
    };
    expect(assertValid(result, schema)).toBe(true);
  });

  test("rejects an unknown status", () => {
    const result = {
      jobId: "job-789",
      collections: ["notes"],
      status: "pending",
      options: {
        gitPull: false,
        runUpdateCmd: false,
      },
    };
    expect(assertInvalid(result, schema)).toBe(true);
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
