/**
 * MCP gno_sync tool - trigger sync jobs.
 *
 * @module src/mcp/tools/sync
 */

import type { Collection } from "../../config/types";
import type { CollectionSyncResult, SyncResult } from "../../ingestion";
import type { ToolContext } from "../server";

import { MCP_ERRORS } from "../../core/errors";
import { acquireWriteLock, type WriteLockHandle } from "../../core/file-lock";
import { JobError } from "../../core/job-manager";
import { normalizeCollectionName } from "../../core/validation";
import { defaultSyncService } from "../../ingestion";
import { runTool, type ToolResult } from "./index";

interface SyncInput {
  collection?: string;
  gitPull?: boolean;
  runUpdateCmd?: boolean;
}

interface SyncResultOutput {
  jobId: string;
  collections: string[];
  status: "started";
  options: {
    gitPull: boolean;
    runUpdateCmd: boolean;
  };
}

function formatSyncResult(result: SyncResultOutput): string {
  const lines: string[] = [];
  lines.push(`Job: ${result.jobId}`);
  lines.push(`Status: ${result.status}`);
  lines.push(`Collections: ${result.collections.join(", ") || "(none)"}`);
  lines.push(`Git pull: ${result.options.gitPull ? "yes" : "no"}`);
  lines.push(`Run update cmd: ${result.options.runUpdateCmd ? "yes" : "no"}`);
  return lines.join("\n");
}

function wrapSingleSync(result: CollectionSyncResult): SyncResult {
  return {
    collections: [result],
    totalDurationMs: result.durationMs,
    totalFilesProcessed: result.filesProcessed,
    totalFilesAdded: result.filesAdded,
    totalFilesUpdated: result.filesUpdated,
    totalFilesErrored: result.filesErrored,
    totalFilesSkipped: result.filesSkipped,
  };
}

function resolveCollection(
  name: string,
  collections: Collection[]
): Collection | null {
  const normalized = normalizeCollectionName(name);
  return (
    collections.find((collection) => collection.name === normalized) ?? null
  );
}

export function handleSync(
  args: SyncInput,
  ctx: ToolContext
): Promise<ToolResult> {
  return runTool(
    ctx,
    "gno_sync",
    async () => {
      if (!ctx.enableWrite) {
        throw new Error("Write tools disabled. Start MCP with --enable-write.");
      }

      let lock: WriteLockHandle | null = null;
      let handedOff = false;

      try {
        lock = await acquireWriteLock(ctx.writeLockPath);
        if (!lock) {
          throw new Error(
            `${MCP_ERRORS.LOCKED.code}: ${MCP_ERRORS.LOCKED.message}`
          );
        }

        const requestedCollection = args.collection?.trim();
        const collection = requestedCollection
          ? resolveCollection(requestedCollection, ctx.collections)
          : null;

        if (requestedCollection && !collection) {
          throw new Error(
            `${MCP_ERRORS.NOT_FOUND.code}: Collection not found: ${requestedCollection}`
          );
        }

        const collections = collection
          ? [collection.name]
          : ctx.collections.map((entry) => entry.name);

        const options = {
          gitPull: args.gitPull ?? false,
          runUpdateCmd: args.runUpdateCmd ?? false,
        };

        const jobId = await ctx.jobManager.startJobWithLock(
          "sync",
          lock,
          async () => {
            if (collection) {
              const result = await defaultSyncService.syncCollection(
                collection,
                ctx.store,
                options
              );
              return wrapSingleSync(result);
            }

            return defaultSyncService.syncAll(
              ctx.collections,
              ctx.store,
              options
            );
          }
        );

        handedOff = true;

        const result: SyncResultOutput = {
          jobId,
          collections,
          status: "started",
          options,
        };

        return result;
      } catch (error) {
        if (error instanceof JobError) {
          throw new Error(`${error.code}: ${error.message}`);
        }
        throw error;
      } finally {
        if (lock && !handedOff) {
          await lock.release();
        }
      }
    },
    formatSyncResult
  );
}
