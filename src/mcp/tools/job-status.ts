/**
 * MCP gno_job_status tool - job status lookup.
 *
 * @module src/mcp/tools/job-status
 */

import type { JobRecord } from "../../core/job-manager";
import type { SyncResult } from "../../ingestion";
import type { ToolContext } from "../server";

import { runTool, type ToolResult } from "./index";

interface JobStatusInput {
  jobId: string;
}

interface JobStatusResult {
  jobId: string;
  type: JobRecord["type"];
  status: JobRecord["status"];
  startedAt: string;
  completedAt?: string;
  result?: SyncResult;
  error?: string;
  serverInstanceId: string;
}

function formatJobStatus(result: JobStatusResult): string {
  const lines: string[] = [];

  lines.push(`Job: ${result.jobId}`);
  lines.push(`Type: ${result.type}`);
  lines.push(`Status: ${result.status}`);
  lines.push(`Started: ${result.startedAt}`);

  if (result.completedAt) {
    lines.push(`Completed: ${result.completedAt}`);
  }

  if (result.error) {
    lines.push(`Error: ${result.error}`);
  }

  if (result.result) {
    lines.push(
      `Total: ${result.result.totalFilesAdded} added, ${result.result.totalFilesUpdated} updated, ` +
        `${result.result.totalFilesErrored} errors`
    );
    lines.push(`Duration: ${result.result.totalDurationMs}ms`);
  }

  return lines.join("\n");
}

function toJobStatusResult(job: JobRecord): JobStatusResult {
  return {
    jobId: job.id,
    type: job.type,
    status: job.status,
    startedAt: new Date(job.startedAt).toISOString(),
    completedAt: job.completedAt
      ? new Date(job.completedAt).toISOString()
      : undefined,
    result: job.result,
    error: job.error,
    serverInstanceId: job.serverInstanceId,
  };
}

export function handleJobStatus(
  args: JobStatusInput,
  ctx: ToolContext
): Promise<ToolResult> {
  return runTool(
    ctx,
    "gno_job_status",
    async () => {
      const job = ctx.jobManager.getJob(args.jobId);
      if (!job) {
        throw new Error(`NOT_FOUND: Job not found: ${args.jobId}`);
      }

      return toJobStatusResult(job);
    },
    formatJobStatus
  );
}
