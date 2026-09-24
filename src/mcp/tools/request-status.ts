/**
 * MCP request receipts: the caller's namespace, error rethrow, and the
 * bounded `gno_request_status` lookup.
 *
 * @module src/mcp/tools/request-status
 */

import { z } from "zod";

import type { ToolContext } from "../server";

import {
  LOCAL_OWNER_NAMESPACE,
  readRequestStatus,
  RequestReceiptError,
  requestLedgerPath,
  type RequestStatusResult,
} from "../../core/request-receipts";
import { runTool, type ToolResult } from "./index";

export const REQUEST_STATUS_MCP_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const requestIdInputSchema = z
  .string()
  .describe(
    "Optional caller request ID (1-128 of A-Z a-z 0-9 . _ : -). Reuse the same ID when retrying the same write after a lost response; a new intent needs a new ID"
  );

export const requestStatusInputSchema = z.object({
  requestId: z
    .string()
    .describe("Request ID previously sent with gno_capture or gno_remember"),
});

/** HTTP callers get their authorized identity's namespace; stdio is the local owner. */
export function mcpRequestNamespace(ctx: ToolContext): string {
  return ctx.getRequestNamespace?.() ?? LOCAL_OWNER_NAMESPACE;
}

/** Re-throw a request receipt error in the `CODE: message` shape runTool parses. */
export function rethrowRequestError(error: unknown): never {
  if (error instanceof RequestReceiptError) {
    throw new Error(`${error.code}: ${error.message}`);
  }
  throw error;
}

function formatRequestStatus(result: RequestStatusResult): string {
  const lines = [`Request: ${result.requestId}`, `Status: ${result.status}`];
  if (result.operation) lines.push(`Operation: ${result.operation}`);
  if (result.updatedAt) lines.push(`Updated: ${result.updatedAt}`);
  if (result.result?.uri) lines.push(`URI: ${result.result.uri}`);
  return lines.join("\n");
}

export function handleRequestStatus(
  args: z.infer<typeof requestStatusInputSchema>,
  ctx: ToolContext
): Promise<ToolResult> {
  return runTool(
    ctx,
    "gno_request_status",
    async () => {
      try {
        return await readRequestStatus({
          ledgerPath: requestLedgerPath(ctx.store.getDbPath()),
          namespace: mcpRequestNamespace(ctx),
          requestId: args.requestId,
        });
      } catch (error) {
        return rethrowRequestError(error);
      }
    },
    formatRequestStatus
  );
}
