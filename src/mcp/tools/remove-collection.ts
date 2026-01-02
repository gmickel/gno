/**
 * MCP gno_remove_collection tool - remove collection from config.
 *
 * @module src/mcp/tools/remove-collection
 */

import type { ToolContext } from "../server";

import { removeCollection } from "../../collection/remove";
import { applyConfigChange } from "../../core/config-mutation";
import { MCP_ERRORS } from "../../core/errors";
import { withWriteLock } from "../../core/file-lock";
import { normalizeCollectionName } from "../../core/validation";
import { runTool, type ToolResult } from "./index";

interface RemoveCollectionInput {
  collection: string;
}

interface RemoveCollectionResult {
  removed: true;
  collection: string;
  configUpdated: true;
  indexedDataRetained: true;
  note: string;
}

function formatRemoveCollectionResult(result: RemoveCollectionResult): string {
  const lines: string[] = [];
  lines.push(`Removed: ${result.collection}`);
  lines.push(result.note);
  return lines.join("\n");
}

function mapConfigError(code: string, message: string): Error {
  switch (code) {
    case "NOT_FOUND":
      return new Error(`${MCP_ERRORS.NOT_FOUND.code}: ${message}`);
    case "HAS_REFERENCES":
      return new Error(`${MCP_ERRORS.HAS_REFERENCES.code}: ${message}`);
    default:
      return new Error(`RUNTIME: ${message}`);
  }
}

export function handleRemoveCollection(
  args: RemoveCollectionInput,
  ctx: ToolContext
): Promise<ToolResult> {
  return runTool(
    ctx,
    "gno_remove_collection",
    async () => {
      if (!ctx.enableWrite) {
        throw new Error("Write tools disabled. Start MCP with --enable-write.");
      }

      return withWriteLock(ctx.writeLockPath, async () => {
        const name = normalizeCollectionName(args.collection);
        if (!name) {
          throw new Error(
            `${MCP_ERRORS.NOT_FOUND.code}: Collection not found: ${args.collection}`
          );
        }

        const mutationResult = await applyConfigChange(
          {
            store: ctx.store,
            configPath: ctx.actualConfigPath,
            onConfigUpdated: (config) => {
              ctx.config = config;
              ctx.collections = config.collections;
            },
          },
          (config) => {
            const removeResult = removeCollection(config, { name });
            if (!removeResult.ok) {
              return {
                ok: false,
                error: removeResult.message,
                code: removeResult.code,
              };
            }

            return { ok: true, config: removeResult.config };
          }
        );

        if (!mutationResult.ok) {
          throw mapConfigError(mutationResult.code, mutationResult.error);
        }

        const result: RemoveCollectionResult = {
          removed: true,
          collection: name,
          configUpdated: true,
          indexedDataRetained: true,
          note: "Documents remain in index until next full reindex or manual cleanup",
        };

        return result;
      });
    },
    formatRemoveCollectionResult
  );
}
