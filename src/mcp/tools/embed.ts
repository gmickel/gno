/**
 * MCP gno_embed tool - embed unembedded chunks.
 *
 * @module src/mcp/tools/embed
 */

import type { ToolContext } from "../server";

import { MCP_ERRORS } from "../../core/errors";
import { acquireWriteLock, type WriteLockHandle } from "../../core/file-lock";
import { JobError } from "../../core/job-manager";
import { embedBacklog } from "../../embed";
import { LlmAdapter } from "../../llm/nodeLlamaCpp/adapter";
import { getActivePreset } from "../../llm/registry";
import {
  createVectorIndexPort,
  createVectorStatsPort,
} from "../../store/vector";
import { runTool, type ToolResult } from "./index";

type EmbedInput = Record<string, never>;

interface EmbedResultOutput {
  jobId: string;
  status: "started";
  model: string;
}

function formatEmbedResult(result: EmbedResultOutput): string {
  const lines: string[] = [];
  lines.push(`Job: ${result.jobId}`);
  lines.push(`Status: ${result.status}`);
  lines.push(`Model: ${result.model}`);
  return lines.join("\n");
}

export function handleEmbed(
  args: EmbedInput,
  ctx: ToolContext
): Promise<ToolResult> {
  return runTool(
    ctx,
    "gno_embed",
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

        // Get model from active preset
        const preset = getActivePreset(ctx.config);
        const modelUri = preset.embed;

        const jobId = await ctx.jobManager.startTypedJobWithLock(
          "embed",
          lock,
          async () => {
            // Create LLM adapter with offline policy (fail-fast, no download)
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
              const result = await embedBacklog({
                statsPort,
                embedPort,
                vectorIndex,
                modelUri,
                batchSize: 32,
              });

              if (!result.ok) {
                throw new Error(result.error.message);
              }

              return {
                kind: "embed" as const,
                value: result.value,
              };
            } finally {
              await embedPort.dispose();
            }
          }
        );

        handedOff = true;

        const result: EmbedResultOutput = {
          jobId,
          status: "started",
          model: modelUri,
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
    formatEmbedResult
  );
}
