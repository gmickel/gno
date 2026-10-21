/**
 * MCP gno_job_status tool - job status lookup.
 *
 * @module src/mcp/tools/job-status
 */

import type { JobRecord, JobResult } from "../../core/job-manager";
import type { SyncResult } from "../../ingestion";
import type { ToolContext } from "../server";

import { runToolNoMutex, type ToolResult } from "./index";

interface JobStatusInput {
  jobId: string;
}

interface JobStatusResult {
  jobId: string;
  type: JobRecord["type"];
  status: JobRecord["status"];
  startedAt: string;
  completedAt?: string;
  /** @deprecated Use typedResult for new job types */
  result?: SyncResult;
  typedResult?: JobResult;
  error?: string;
  scope?: JobRecord["scope"];
  serverInstanceId: string;
}

function formatJobStatus(result: JobStatusResult): string {
  const lines: string[] = [];

  lines.push(`Job: ${result.jobId}`);
  lines.push(`Type: ${result.type}`);
  lines.push(`Status: ${result.status}`);
  lines.push(`Started: ${result.startedAt}`);
  if (result.scope) {
    lines.push(`Collection: ${result.scope.collection ?? "(all)"}`);
    if (result.scope.paths)
      lines.push(`Paths: ${result.scope.paths.join(", ")}`);
  }

  if (result.completedAt) {
    lines.push(`Completed: ${result.completedAt}`);
  }

  if (result.error) {
    lines.push(`Error: ${result.error}`);
  }

  // Handle typed results (embed, index jobs)
  if (result.typedResult) {
    switch (result.typedResult.kind) {
      case "embed":
        lines.push(
          `Embedded: ${result.typedResult.value.embedded} chunks, ${result.typedResult.value.errors} errors`
        );
        break;
      case "index": {
        const { sync, embed } = result.typedResult.value;
        lines.push(
          `Sync: ${sync.totalFilesAdded} added, ${sync.totalFilesUpdated} updated, ${sync.totalFilesErrored} errors`
        );
        lines.push(`Embed: ${embed.embedded} chunks, ${embed.errors} errors`);
        lines.push(`Duration: ${sync.totalDurationMs}ms`);
        break;
      }
      case "sync":
        lines.push(
          `Total: ${result.typedResult.value.totalFilesAdded} added, ${result.typedResult.value.totalFilesUpdated} updated, ` +
            `${result.typedResult.value.totalFilesErrored} errors`
        );
        lines.push(`Duration: ${result.typedResult.value.totalDurationMs}ms`);
        break;
    }
  } else if (result.result) {
    // Legacy sync result
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
    typedResult: job.typedResult,
    error: job.error,
    ...(job.scope ? { scope: job.scope } : {}),
    serverInstanceId: job.serverInstanceId,
  };
}

export function handleJobStatus(
  args: JobStatusInput,
  ctx: ToolContext
): Promise<ToolResult> {
  // Use runToolNoMutex - job status is in-memory only, should not block
  return runToolNoMutex(
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
