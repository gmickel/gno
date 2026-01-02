/**
 * MCP gno_list_jobs tool - list active/recent jobs.
 *
 * @module src/mcp/tools/list-jobs
 */

import type { JobRecord } from "../../core/job-manager";
import type { ToolContext } from "../server";

import { runTool, type ToolResult } from "./index";

interface ListJobsInput {
  limit?: number;
}

interface ListJobsResult {
  active: Array<{
    jobId: string;
    type: JobRecord["type"];
    startedAt: string;
  }>;
  recent: Array<{
    jobId: string;
    type: JobRecord["type"];
    status: "completed" | "failed";
    completedAt: string;
  }>;
}

function formatListJobs(result: ListJobsResult): string {
  const lines: string[] = [];

  lines.push(`Active: ${result.active.length}`);
  for (const job of result.active) {
    lines.push(`  ${job.jobId} (${job.type}) started ${job.startedAt}`);
  }

  lines.push("");
  lines.push(`Recent: ${result.recent.length}`);
  for (const job of result.recent) {
    lines.push(
      `  ${job.jobId} (${job.type}) ${job.status} at ${job.completedAt}`
    );
  }

  return lines.join("\n");
}

function toListJobsResult(
  active: JobRecord[],
  recent: JobRecord[]
): ListJobsResult {
  return {
    active: active.map((job) => ({
      jobId: job.id,
      type: job.type,
      startedAt: new Date(job.startedAt).toISOString(),
    })),
    recent: recent.map((job) => ({
      jobId: job.id,
      type: job.type,
      status: job.status === "failed" ? "failed" : "completed",
      completedAt: new Date(job.completedAt ?? job.startedAt).toISOString(),
    })),
  };
}

export function handleListJobs(
  args: ListJobsInput,
  ctx: ToolContext
): Promise<ToolResult> {
  return runTool(
    ctx,
    "gno_list_jobs",
    async () => {
      const { active, recent } = ctx.jobManager.listJobs(args.limit ?? 10);
      return toListJobsResult(active, recent);
    },
    formatListJobs
  );
}
