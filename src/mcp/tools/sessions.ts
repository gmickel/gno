/**
 * MCP session-archive tools: bounded status and import of owner-registered
 * sources. Thin adapters over the core sessions service.
 *
 * Remote callers never discover host directories and never name paths:
 * import accepts a registered source ID only. Import is registered only with
 * `--enable-write`, and neither tool is part of the core profile.
 *
 * @module src/mcp/tools/sessions
 */

import { z } from "zod";

import type { ToolContext } from "../server";

import {
  formatImportReceiptText,
  formatStatusText,
} from "../../sessions/format";
import { importInChildProcess } from "../../sessions/import-child";
import { SessionsService } from "../../sessions/service";
import {
  MAX_IMPORT_LIMIT,
  type SessionImportReceipt,
  remoteSafeSessionsError,
} from "../../sessions/types";
import { runTool, type ToolResult } from "./index";

export const sessionsStatusInputSchema = z.object({});

export const sessionsImportInputSchema = z
  .object({
    sourceId: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .describe(
        "ID of an owner-registered session source (see gno_sessions_status)"
      ),
    dryRun: z
      .boolean()
      .optional()
      .describe("Parse and report without writing archive or index state"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_IMPORT_LIMIT)
      .optional()
      .describe(
        "Maximum changed units processed this call; the rest are deferred"
      ),
  })
  .strict();

export type SessionsImportToolInput = z.infer<typeof sessionsImportInputSchema>;

export const SESSIONS_STATUS_MCP_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const SESSIONS_IMPORT_MCP_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function service(ctx: ToolContext): SessionsService {
  return new SessionsService({
    config: ctx.config,
    configPath: ctx.actualConfigPath,
    indexName: ctx.indexName,
    store: ctx.store,
  });
}

/** Re-throw as `CODE: message` (the shape runTool parses), never with host paths. */
function rethrowSessionsError(error: unknown): never {
  const typed = remoteSafeSessionsError(error);
  throw new Error(`${typed.code}: ${typed.message}`);
}

export function handleSessionsStatus(ctx: ToolContext): Promise<ToolResult> {
  return runTool(
    ctx,
    "gno_sessions_status",
    async () => {
      try {
        return await service(ctx).status();
      } catch (error) {
        return rethrowSessionsError(error);
      }
    },
    formatStatusText
  );
}

export function handleSessionsImport(
  args: SessionsImportToolInput,
  ctx: ToolContext
): Promise<ToolResult> {
  return runTool(
    ctx,
    "gno_sessions_import",
    async () => {
      if (!ctx.enableWrite) {
        throw new Error(
          "WRITE_DISABLED: gno_sessions_import requires --enable-write or GNO_MCP_ENABLE_WRITE=1"
        );
      }
      let receipt: SessionImportReceipt;
      try {
        // A child process keeps this server answering during a long import.
        receipt = await importInChildProcess({
          config: ctx.config,
          configPath: ctx.actualConfigPath,
          indexName: ctx.indexName,
          sourceId: args.sourceId,
          dryRun: args.dryRun === true,
          limit: args.limit,
        });
      } catch (error) {
        return rethrowSessionsError(error);
      }
      if (!receipt.dryRun && receipt.lexical.collections.length > 0) {
        ctx.markContentMutation?.();
        ctx.markIndexMutation?.();
      }
      return receipt;
    },
    formatImportReceiptText
  );
}
