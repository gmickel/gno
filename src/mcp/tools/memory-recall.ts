/**
 * MCP gno_recall tool - budgeted, cited, current-state memory recall.
 *
 * Thin adapter over the core `MemoryService`. Identity is mapped from the
 * server session (MCP client name + transport session), never from tool
 * arguments. The service owns the shared write lease; this module never
 * touches `ctx.writeLockPath` beyond naming the lease file for the service.
 *
 * @module src/mcp/tools/memory-recall
 */

import { z } from "zod";

import type { ToolContext } from "../server";

import {
  MEMORY_RECALL_MAX_FACTS,
  MEMORY_RECALL_MAX_TOKENS,
  MemoryError,
  MemoryService,
  type MemoryIdentity,
  type RecallResult,
} from "../../core/memory";
import { MEMORY_MAX_SCOPES } from "../../core/memory-record";
import { runTool, type ToolResult } from "./index";

/** Caller name when the MCP client sent no implementation name. */
const DEFAULT_MCP_CALLER = "mcp";

export const RECALL_MCP_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** Server-side identity inputs resolved at dispatch time by the registry. */
export interface McpMemorySessionInfo {
  /** `clientInfo.name` from the MCP initialize handshake. */
  clientName?: string;
  /** Transport session id (Streamable HTTP); absent on stdio. */
  sessionId?: string;
}

export const memoryScopesInputSchema = z
  .array(z.string().trim().min(1))
  .min(1, "At least one explicit scope is required")
  .max(MEMORY_MAX_SCOPES)
  .describe(
    `Explicit scopes (1-${MEMORY_MAX_SCOPES}, e.g. "project:gno"). Visibility is any-intersection; there is no implicit global scope`
  );

export const recallInputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1, "Query cannot be empty")
    .describe("What you need to know, phrased as the fact would be stated"),
  collection: z
    .string()
    .trim()
    .min(1, "Collection cannot be empty")
    .describe("Memory-managed collection to recall from"),
  scopes: memoryScopesInputSchema,
  maxFacts: z
    .number()
    .int()
    .min(1)
    .max(64)
    .optional()
    .describe(`Fact budget (default ${MEMORY_RECALL_MAX_FACTS})`),
  maxTokens: z
    .number()
    .int()
    .min(1)
    .max(8192)
    .optional()
    .describe(`Payload token budget (default ${MEMORY_RECALL_MAX_TOKENS})`),
});

export type RecallToolInput = z.infer<typeof recallInputSchema>;

/**
 * Map the MCP server session to the core identity contract.
 *
 * caller = MCP client implementation name; session = transport session id
 * when the transport has one (Streamable HTTP), else the per-process server
 * instance id (stdio: one process is one session).
 */
export function resolveMcpMemoryIdentity(
  ctx: ToolContext,
  info: McpMemorySessionInfo
): MemoryIdentity {
  const caller = info.clientName?.trim() || DEFAULT_MCP_CALLER;
  const session = info.sessionId?.trim() || ctx.serverInstanceId;
  return { caller, session };
}

/**
 * Construct the core service for one MCP call.
 *
 * The lease path names the same `.mcp-write.lock` file the rest of the MCP
 * write surface uses, so a memory write and a capture serialise on one lease.
 * Acquisition happens inside the service only.
 */
export function createMcpMemoryService(ctx: ToolContext): MemoryService {
  return new MemoryService({
    store: ctx.store,
    config: ctx.config,
    collections: ctx.collections,
    lockPath: ctx.writeLockPath,
  });
}

/** Re-throw a core memory error in the `CODE: message` shape runTool parses. */
export function rethrowMemoryError(error: unknown): never {
  if (error instanceof MemoryError) {
    throw new Error(`${error.code}: ${error.message}`);
  }
  throw error;
}

export function formatRecallResult(result: RecallResult): string {
  const lines: string[] = [];
  lines.push(
    `Facts: ${result.facts.length} (budget ${result.budget.maxFacts} facts / ${result.budget.maxTokens} tokens, used ${result.budget.usedTokens}, omitted ${result.budget.omitted})`
  );
  lines.push(
    `Retrieval: ${result.retrieval.mode}${
      result.retrieval.semanticUnavailable
        ? ` (${result.retrieval.semanticUnavailable})`
        : ""
    }`
  );
  for (const fact of result.facts) {
    lines.push("");
    lines.push(`- ${fact.text}`);
    lines.push(`  cite: ${fact.uri}`);
    lines.push(
      `  scopes: ${fact.scopes.join(", ")} | hash: ${fact.contentHash} | created: ${fact.createdAt}`
    );
  }
  if (result.hint) {
    lines.push("");
    lines.push(result.hint);
  }
  lines.push("");
  lines.push(
    `Receipt: ${result.receipt.digest} (caller ${result.receipt.caller}, session ${result.receipt.session}, ${result.receipt.memoryIds.length} ids)`
  );
  return lines.join("\n");
}

export function handleRecall(
  args: RecallToolInput,
  ctx: ToolContext,
  info: McpMemorySessionInfo = {}
): Promise<ToolResult> {
  return runTool(
    ctx,
    "gno_recall",
    async () => {
      const service = createMcpMemoryService(ctx);
      try {
        return await service.recall({
          ...resolveMcpMemoryIdentity(ctx, info),
          query: args.query,
          collection: args.collection,
          scopes: args.scopes,
          maxFacts: args.maxFacts,
          maxTokens: args.maxTokens,
        });
      } catch (error) {
        return rethrowMemoryError(error);
      }
    },
    formatRecallResult
  );
}
