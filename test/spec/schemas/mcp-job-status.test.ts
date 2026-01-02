import { beforeAll, describe, expect, test } from "bun:test";

import { assertInvalid, assertValid, loadSchema } from "./validator";

describe("mcp-job-status schema", () => {
  let schema: object;

  beforeAll(async () => {
    schema = await loadSchema("mcp-job-status");
  });

  test("valid running job status", () => {
    const status = {
      jobId: "job-1",
      type: "sync",
      status: "running",
      startedAt: "2026-01-02T12:00:00Z",
      serverInstanceId: "550e8400-e29b-41d4-a716-446655440000",
    };
    expect(assertValid(status, schema)).toBe(true);
  });

  test("valid completed job status with result", () => {
    const status = {
      jobId: "job-2",
      type: "add",
      status: "completed",
      startedAt: "2026-01-02T12:00:00Z",
      completedAt: "2026-01-02T12:01:00Z",
      serverInstanceId: "550e8400-e29b-41d4-a716-446655440000",
      result: {
        collections: [
          {
            collection: "notes",
            filesProcessed: 2,
            filesAdded: 1,
            filesUpdated: 1,
            filesUnchanged: 0,
            filesErrored: 0,
            filesSkipped: 0,
            filesMarkedInactive: 0,
            durationMs: 1200,
            errors: [],
          },
        ],
        totalDurationMs: 1200,
        totalFilesProcessed: 2,
        totalFilesAdded: 1,
        totalFilesUpdated: 1,
        totalFilesErrored: 0,
        totalFilesSkipped: 0,
      },
    };
    expect(assertValid(status, schema)).toBe(true);
  });

  test("rejects missing jobId", () => {
    const status = {
      type: "sync",
      status: "running",
      startedAt: "2026-01-02T12:00:00Z",
      serverInstanceId: "550e8400-e29b-41d4-a716-446655440000",
    };
    expect(assertInvalid(status, schema)).toBe(true);
  });
});
