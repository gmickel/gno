/**
 * MCP gno_job_status tool tests.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";

const syncResultSchema = z.object({
  collections: z.array(
    z.object({
      collection: z.string(),
      filesProcessed: z.number(),
      filesAdded: z.number(),
      filesUpdated: z.number(),
      filesErrored: z.number(),
      filesSkipped: z.number(),
      filesMarkedInactive: z.number(),
      durationMs: z.number(),
      errors: z.array(
        z.object({
          relPath: z.string(),
          code: z.string(),
          message: z.string(),
        })
      ),
    })
  ),
  totalDurationMs: z.number(),
  totalFilesProcessed: z.number(),
  totalFilesAdded: z.number(),
  totalFilesUpdated: z.number(),
  totalFilesErrored: z.number(),
  totalFilesSkipped: z.number(),
});

const jobStatusSchema = z.object({
  jobId: z.string(),
  type: z.enum(["sync", "add"]),
  status: z.enum(["running", "completed", "failed"]),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  result: syncResultSchema.optional(),
  error: z.string().optional(),
  serverInstanceId: z.string().optional(),
});

describe("gno_job_status schema", () => {
  test("running job status schema", () => {
    const running = {
      jobId: "job-1",
      type: "sync",
      status: "running",
      startedAt: new Date().toISOString(),
    };

    const result = jobStatusSchema.safeParse(running);
    expect(result.success).toBe(true);
  });

  test("completed job status schema", () => {
    const completed = {
      jobId: "job-2",
      type: "add",
      status: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      serverInstanceId: "srv-1",
      result: {
        collections: [
          {
            collection: "notes",
            filesProcessed: 10,
            filesAdded: 4,
            filesUpdated: 2,
            filesErrored: 1,
            filesSkipped: 3,
            filesMarkedInactive: 0,
            durationMs: 1234,
            errors: [],
          },
        ],
        totalDurationMs: 1234,
        totalFilesProcessed: 10,
        totalFilesAdded: 4,
        totalFilesUpdated: 2,
        totalFilesErrored: 1,
        totalFilesSkipped: 3,
      },
    };

    const result = jobStatusSchema.safeParse(completed);
    expect(result.success).toBe(true);
  });

  test("failed job status schema", () => {
    const failed = {
      jobId: "job-3",
      type: "sync",
      status: "failed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: "Boom",
    };

    const result = jobStatusSchema.safeParse(failed);
    expect(result.success).toBe(true);
  });
});
