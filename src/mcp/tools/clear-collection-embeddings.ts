/**
 * MCP gno_clear_collection_embeddings tool.
 *
 * @module src/mcp/tools/clear-collection-embeddings
 */

import type { ToolContext } from "../server";

import { MCP_ERRORS } from "../../core/errors";
import { withWriteLock } from "../../core/file-lock";
import { resolveModelUri } from "../../llm/registry";
import { runTool, type ToolResult } from "./index";

interface ClearCollectionEmbeddingsInput {
  collection: string;
  mode?: "stale" | "all";
}

interface ClearCollectionEmbeddingsResult {
  collection: string;
  deletedVectors: number;
  deletedModels: string[];
  mode: "stale" | "all";
  protectedSharedVectors: number;
  note?: string;
}

function formatResult(result: ClearCollectionEmbeddingsResult): string {
  const lines = [
    `Collection: ${result.collection}`,
    `Mode: ${result.mode}`,
    `Deleted vectors: ${result.deletedVectors}`,
  ];
  if (result.deletedModels.length > 0) {
    lines.push(`Models: ${result.deletedModels.join(", ")}`);
  }
  if (result.protectedSharedVectors > 0) {
    lines.push(`Protected shared vectors: ${result.protectedSharedVectors}`);
  }
  if (result.note) {
    lines.push(result.note);
  }
  return lines.join("\n");
}

export function handleClearCollectionEmbeddings(
  args: ClearCollectionEmbeddingsInput,
  ctx: ToolContext
): Promise<ToolResult> {
  return runTool(
    ctx,
    "gno_clear_collection_embeddings",
    async () => {
      if (!ctx.enableWrite) {
        throw new Error("Write tools disabled. Start MCP with --enable-write.");
      }

      const collection = ctx.collections.find(
        (item) => item.name === args.collection
      );
      if (!collection) {
        throw new Error(
          `${MCP_ERRORS.NOT_FOUND.code}: Collection not found: ${args.collection}`
        );
      }

      const mode = args.mode ?? "stale";
      return withWriteLock(ctx.writeLockPath, async () => {
        const result = await ctx.store.clearEmbeddingsForCollection(
          collection.name,
          {
            mode,
            activeModel: resolveModelUri(
              ctx.config,
              "embed",
              undefined,
              collection.name
            ),
          }
        );
        if (!result.ok) {
          throw new Error(`${result.error.code}: ${result.error.message}`);
        }

        return {
          ...result.value,
          note:
            mode === "all"
              ? `Run gno_embed or gno_index for ${collection.name} to rebuild embeddings.`
              : undefined,
        };
      });
    },
    formatResult
  );
}
