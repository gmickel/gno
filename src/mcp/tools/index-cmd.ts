/**
 * MCP gno_index tool - sync + embed as single job.
 *
 * @module src/mcp/tools/index-cmd
 */

import type { Collection } from "../../config/types";
import type { ToolContext } from "../server";

import { MCP_ERRORS } from "../../core/errors";
import { JobError } from "../../core/job-manager";
import {
  recordContentMutation,
  recordIndexMutation,
} from "../../core/mutation-generations";
import { resolveReindexScope } from "../../core/reindex-paths";
import { normalizeCollectionName } from "../../core/validation";
import { embedBacklog } from "../../embed";
import { defaultSyncService, withContentTypeRules } from "../../ingestion";
import { LlmAdapter } from "../../llm/nodeLlamaCpp/adapter";
import { resolveModelUri } from "../../llm/registry";
import {
  createVectorIndexPort,
  createVectorStatsPort,
} from "../../store/vector";
import { enforceSyncCommandEgress } from "../sync-egress";
import { runTool, type ToolResult } from "./index";

interface IndexInput {
  collection?: string;
  gitPull?: boolean;
  paths?: string[];
}

interface IndexResultOutput {
  jobId: string;
  status: "started" | "queued";
  collections: string[];
  paths?: string[];
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
  if (result.paths) lines.push(`Paths: ${result.paths.join(", ")}`);
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

      try {
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
            // Security: MCP never runs updateCmd by default
            runUpdateCmd: false,
          },
          ctx.config
        );
        const paths = await resolveReindexScope(
          collection,
          args.paths,
          options
        );
        enforceSyncCommandEgress(ctx, {
          collectionNames: collections,
          gitPull: options.gitPull,
          runUpdateCmd: options.runUpdateCmd,
        });

        // Captured now: a queued pass runs after this call's context is gone.
        const config = ctx.config;
        const allCollections = ctx.collections;
        const accepted = await ctx.jobManager.submitReindex({
          type: "index",
          collection: collection?.name ?? null,
          paths,
          options: {
            gitPull: options.gitPull ?? false,
            runUpdateCmd: options.runUpdateCmd ?? false,
          },
          run: async (scope) => {
            const lease = ctx.acquireModelLease?.();
            const passOptions = withContentTypeRules(
              { ...scope.options },
              config
            );
            try {
              // Phase 1: Sync
              const syncResult = collection
                ? await (
                    scope.paths
                      ? defaultSyncService.syncPaths(
                          collection,
                          ctx.store,
                          scope.paths,
                          passOptions
                        )
                      : defaultSyncService.syncCollection(
                          collection,
                          ctx.store,
                          passOptions
                        )
                  ).then((r) => ({
                    collections: [r],
                    totalDurationMs: r.durationMs,
                    totalFilesProcessed: r.filesProcessed,
                    totalFilesAdded: r.filesAdded,
                    totalFilesUpdated: r.filesUpdated,
                    totalFilesErrored: r.filesErrored,
                    totalFilesSkipped: r.filesSkipped,
                  }))
                : await defaultSyncService.syncAll(
                    allCollections,
                    ctx.store,
                    passOptions
                  );
              recordContentMutation(syncResult, ctx.markContentMutation);

              // Phase 2: Embed. The model is looked up when the pass runs: a
              // queued pass outlives a server reload, which disposes the
              // adapter that was current at submit.
              const liveConfig = ctx.config;
              const modelUri = resolveModelUri(
                liveConfig,
                "embed",
                undefined,
                collection?.name
              );
              const llm = ctx.getModelAdapter?.() ?? new LlmAdapter(liveConfig);
              const embedResult = await llm.createEmbeddingPort(modelUri, {
                egressCollections: collections,
                policy: { offline: true, allowDownload: false },
              });

              if (!embedResult.ok) {
                throw new Error(
                  `MODEL_NOT_FOUND: Embedding model not cached. ` +
                    `Model: ${modelUri}. ` +
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
                  collection: collection?.name,
                  modelUri,
                  batchSize: 32,
                });

                if (!backlogResult.ok) {
                  throw new Error(backlogResult.error.message);
                }
                recordIndexMutation(
                  backlogResult.value.embedded,
                  ctx.markIndexMutation
                );

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
            } finally {
              lease?.release();
            }
          },
        });

        const result: IndexResultOutput = {
          jobId: accepted.jobId,
          collections,
          status: accepted.status === "running" ? "started" : "queued",
          ...(paths ? { paths } : {}),
          phases: ["sync", "embed"],
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
    formatIndexResult
  );
}
