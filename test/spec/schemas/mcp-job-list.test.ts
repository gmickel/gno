import { beforeAll, describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

describe("mcp-job-list schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("mcp-job-list");
  });

  test("valid job list", () => {
    const result = {
      active: [
        {
          jobId: "job-1",
          type: "sync",
          startedAt: "2026-01-02T12:00:00Z",
        },
      ],
      recent: [
        {
          jobId: "job-2",
          type: "add",
          status: "completed",
          completedAt: "2026-01-02T12:01:00Z",
        },
      ],
    };
    expect(assertValid(result, schema)).toBe(true);
  });

  test("rejects missing recent array", () => {
    const result = {
      active: [],
    };
    expect(assertInvalid(result, schema)).toBe(true);
  });
});
