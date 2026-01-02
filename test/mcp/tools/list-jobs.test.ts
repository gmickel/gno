/**
 * MCP gno_list_jobs tool tests.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";

const listJobsSchema = z.object({
  active: z.array(
    z.object({
      jobId: z.string(),
      type: z.enum(["sync", "add"]),
      startedAt: z.string(),
    })
  ),
  recent: z.array(
    z.object({
      jobId: z.string(),
      type: z.enum(["sync", "add"]),
      status: z.enum(["completed", "failed"]),
      completedAt: z.string(),
    })
  ),
});

describe("gno_list_jobs schema", () => {
  test("list jobs schema accepts empty lists", () => {
    const empty = { active: [], recent: [] };
    const result = listJobsSchema.safeParse(empty);
    expect(result.success).toBe(true);
  });

  test("list jobs schema accepts active and recent jobs", () => {
    const sample = {
      active: [
        {
          jobId: "job-1",
          type: "sync",
          startedAt: new Date().toISOString(),
        },
      ],
      recent: [
        {
          jobId: "job-2",
          type: "add",
          status: "completed",
          completedAt: new Date().toISOString(),
        },
      ],
    };

    const result = listJobsSchema.safeParse(sample);
    expect(result.success).toBe(true);
  });
});
