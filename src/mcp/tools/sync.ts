/**
 * MCP gno_sync tool - trigger sync jobs.
 *
 * @module src/mcp/tools/sync
 */

import type { Collection } from "../../config/types";
import type { CollectionSyncResult, SyncResult } from "../../ingestion";
import type { ToolContext } from "../server";

import { MCP_ERRORS } from "../../core/errors";
import { JobError } from "../../core/job-manager";
import { recordContentMutation } from "../../core/mutation-generations";
import { resolveReindexScope } from "../../core/reindex-paths";
import { normalizeCollectionName } from "../../core/validation";
import { defaultSyncService, withContentTypeRules } from "../../ingestion";
import { enforceSyncCommandEgress } from "../sync-egress";
import { runTool, type ToolResult } from "./index";

interface SyncInput {
  collection?: string;
  gitPull?: boolean;
  runUpdateCmd?: boolean;
  paths?: string[];
}

interface SyncResultOutput {
  jobId: string;
  collections: string[];
  status: "started" | "queued";
  paths?: string[];
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
  if (result.paths) lines.push(`Paths: ${result.paths.join(", ")}`);
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

      const options = withContentTypeRules(
        {
          gitPull: args.gitPull ?? false,
          runUpdateCmd: args.runUpdateCmd ?? false,
        },
        ctx.config
      );
      const paths = await resolveReindexScope(collection, args.paths, options);
      enforceSyncCommandEgress(ctx, {
        collectionNames: collections,
        gitPull: options.gitPull,
        runUpdateCmd: options.runUpdateCmd,
      });

      // Captured now: a queued pass runs after this call's context is gone.
      const config = ctx.config;
      const allCollections = ctx.collections;
      try {
        const accepted = await ctx.jobManager.submitReindex({
          type: "sync",
          collection: collection?.name ?? null,
          paths,
          options: {
            gitPull: options.gitPull ?? false,
            runUpdateCmd: options.runUpdateCmd ?? false,
          },
          run: async (scope) => {
            const passOptions = withContentTypeRules(
              { ...scope.options },
              config
            );
            const result = collection
              ? wrapSingleSync(
                  scope.paths
                    ? await defaultSyncService.syncPaths(
                        collection,
                        ctx.store,
                        scope.paths,
                        passOptions
                      )
                    : await defaultSyncService.syncCollection(
                        collection,
                        ctx.store,
                        passOptions
                      )
                )
              : await defaultSyncService.syncAll(
                  allCollections,
                  ctx.store,
                  passOptions
                );
            recordContentMutation(result, ctx.markContentMutation);
            return { kind: "sync" as const, value: result };
          },
        });

        const result: SyncResultOutput = {
          jobId: accepted.jobId,
          collections,
          status: accepted.status === "running" ? "started" : "queued",
          ...(paths ? { paths } : {}),
          options: {
            gitPull: options.gitPull ?? false,
            runUpdateCmd: options.runUpdateCmd ?? false,
          },
        };

        return result;
      } catch (error) {
        if (error instanceof JobError) {
          throw new Error(`${error.code}: ${error.message}`);
        }
        throw error;
      }
    },
    formatSyncResult
  );
}
