/**
 * MCP gno_index tool - sync + embed as single job.
 *
 * @module src/mcp/tools/index-cmd
 */

import type { Collection } from "../../config/types";
import type { ToolContext } from "../server";

import { MCP_ERRORS } from "../../core/errors";
import { acquireWriteLock, type WriteLockHandle } from "../../core/file-lock";
import { JobError } from "../../core/job-manager";
import { normalizeCollectionName } from "../../core/validation";
import { embedBacklog } from "../../embed";
import { defaultSyncService } from "../../ingestion";
import { LlmAdapter } from "../../llm/nodeLlamaCpp/adapter";
import { getActivePreset } from "../../llm/registry";
import {
  createVectorIndexPort,
  createVectorStatsPort,
} from "../../store/vector";
import { runTool, type ToolResult } from "./index";

interface IndexInput {
  collection?: string;
  gitPull?: boolean;
}

interface IndexResultOutput {
  jobId: string;
  status: "started";
  collections: string[];
  phases: ["sync", "embed"];
  options: {
    gitPull: boolean;
    runUpdateCmd: boolean;
  };
}

function formatIndexResult(result: IndexResultOutput): string {
  const lines: string[] = [];
  lines.push(`Job: ${result.jobId}`);
  lines.push(`Status: ${result.status}`);
  lines.push(`Collections: ${result.collections.join(", ") || "(none)"}`);
  lines.push(`Phases: ${result.phases.join(" → ")}`);
  lines.push(`Git pull: ${result.options.gitPull ? "yes" : "no"}`);
  return lines.join("\n");
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

export function handleIndex(
  args: IndexInput,
  ctx: ToolContext
): Promise<ToolResult> {
  return runTool(
    ctx,
    "gno_index",
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
          // Security: MCP never runs updateCmd by default
          runUpdateCmd: false,
        };

        // Get model from active preset
        const preset = getActivePreset(ctx.config);
        const modelUri = preset.embed;

        const jobId = await ctx.jobManager.startTypedJobWithLock(
          "index",
          lock,
          async () => {
            // Phase 1: Sync
            const syncResult = collection
              ? await defaultSyncService
                  .syncCollection(collection, ctx.store, options)
                  .then((r) => ({
                    collections: [r],
                    totalDurationMs: r.durationMs,
                    totalFilesProcessed: r.filesProcessed,
                    totalFilesAdded: r.filesAdded,
                    totalFilesUpdated: r.filesUpdated,
                    totalFilesErrored: r.filesErrored,
                    totalFilesSkipped: r.filesSkipped,
                  }))
              : await defaultSyncService.syncAll(
                  ctx.collections,
                  ctx.store,
                  options
                );

            // Phase 2: Embed
            const llm = new LlmAdapter(ctx.config);
            const embedResult = await llm.createEmbeddingPort(modelUri, {
              policy: { offline: true, allowDownload: false },
            });

            if (!embedResult.ok) {
              throw new Error(
                `MODEL_NOT_FOUND: Embedding model not cached. ` +
                  `Model: ${modelUri}, Preset: ${preset.name}. ` +
                  `Run 'gno models pull embed' first.`
              );
            }

            const embedPort = embedResult.value;

            try {
              // Initialize and get dimensions from port interface
              const initResult = await embedPort.init();
              if (!initResult.ok) {
                throw new Error(initResult.error.message);
              }
              const dimensions = embedPort.dimensions();

              // Create vector index port
              const db = ctx.store.getRawDb();
              const vectorResult = await createVectorIndexPort(db, {
                model: modelUri,
                dimensions,
              });
              if (!vectorResult.ok) {
                throw new Error(vectorResult.error.message);
              }
              const vectorIndex = vectorResult.value;

              // Create stats port for backlog
              const statsPort = createVectorStatsPort(db);

              // Run embedding
              const backlogResult = await embedBacklog({
                statsPort,
                embedPort,
                vectorIndex,
                modelUri,
                batchSize: 32,
              });

              if (!backlogResult.ok) {
                throw new Error(backlogResult.error.message);
              }

              return {
                kind: "index" as const,
                value: {
                  sync: syncResult,
                  embed: backlogResult.value,
                },
              };
            } finally {
              await embedPort.dispose();
            }
          }
        );

        handedOff = true;

        const result: IndexResultOutput = {
          jobId,
          collections,
          status: "started",
          phases: ["sync", "embed"],
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
    formatIndexResult
  );
}
