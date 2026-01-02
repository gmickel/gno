/**
 * MCP gno_add_collection tool - add collection and sync.
 *
 * @module src/mcp/tools/add-collection
 */

// node:path for basename (no Bun path utils)
import { basename } from "node:path";

import type { ToolContext } from "../server";

import { addCollection } from "../../collection/add";
import { applyConfigChange } from "../../core/config-mutation";
import { MCP_ERRORS } from "../../core/errors";
import { acquireWriteLock, type WriteLockHandle } from "../../core/file-lock";
import { JobError } from "../../core/job-manager";
import {
  normalizeCollectionName,
  validateCollectionRoot,
} from "../../core/validation";
import { defaultSyncService } from "../../ingestion";
import { runTool, type ToolResult } from "./index";

interface AddCollectionInput {
  path: string;
  name?: string;
  pattern?: string;
  include?: string[];
  exclude?: string[];
  gitPull?: boolean;
}

interface AddCollectionResult {
  jobId: string;
  collection: string;
  status: "started";
}

function formatAddCollectionResult(result: AddCollectionResult): string {
  return [
    `Job: ${result.jobId}`,
    `Collection: ${result.collection}`,
    `Status: ${result.status}`,
  ].join("\n");
}

function mapConfigError(code: string, message: string): Error {
  switch (code) {
    case "DUPLICATE":
      return new Error(`${MCP_ERRORS.DUPLICATE.code}: ${message}`);
    case "PATH_NOT_FOUND":
      return new Error(`${MCP_ERRORS.PATH_NOT_FOUND.code}: ${message}`);
    case "VALIDATION":
      return new Error(`${MCP_ERRORS.INVALID_PATH.code}: ${message}`);
    default:
      return new Error(`RUNTIME: ${message}`);
  }
}

export function handleAddCollection(
  args: AddCollectionInput,
  ctx: ToolContext
): Promise<ToolResult> {
  return runTool(
    ctx,
    "gno_add_collection",
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

        let absPath: string;
        try {
          absPath = await validateCollectionRoot(args.path);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          throw new Error(`${MCP_ERRORS.INVALID_PATH.code}: ${message}`);
        }

        const rawName = args.name ?? basename(absPath);
        const collectionName = normalizeCollectionName(rawName);
        if (!collectionName) {
          throw new Error(
            `${MCP_ERRORS.INVALID_PATH.code}: Collection name cannot be empty`
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
          async (config) => {
            const addResult = await addCollection(config, {
              path: absPath,
              name: collectionName,
              pattern: args.pattern,
              include: args.include,
              exclude: args.exclude,
            });

            if (!addResult.ok) {
              return {
                ok: false,
                error: addResult.message,
                code: addResult.code,
              };
            }

            return {
              ok: true,
              config: addResult.config,
              value: addResult.collection,
            };
          }
        );

        if (!mutationResult.ok) {
          throw mapConfigError(mutationResult.code, mutationResult.error);
        }

        const collection = mutationResult.value;
        if (!collection) {
          throw new Error("RUNTIME: Collection missing after add");
        }

        const jobId = await ctx.jobManager.startJobWithLock(
          "add",
          lock,
          async () => {
            const result = await defaultSyncService.syncCollection(
              collection,
              ctx.store,
              {
                gitPull: args.gitPull ?? false,
                runUpdateCmd: false,
              }
            );

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
        );

        handedOff = true;

        const result: AddCollectionResult = {
          jobId,
          collection: collection.name,
          status: "started",
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
    formatAddCollectionResult
  );
}
