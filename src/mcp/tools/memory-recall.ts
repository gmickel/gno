/**
 * MCP gno_recall tool - budgeted, cited, current-state memory recall.
 *
 * Thin adapter over the core `MemoryService`. Identity is mapped from the
 * server session (MCP client name + transport session), never from tool
 * arguments; see `memory-shared` for the mapping and service construction.
 *
 * @module src/mcp/tools/memory-recall
 */

import { z } from "zod";

import type { ToolContext } from "../server";

import {
  MEMORY_RECALL_MAX_FACTS,
  MEMORY_RECALL_MAX_TOKENS,
  type RecallResult,
} from "../../core/memory";
import { runTool, type ToolResult } from "./index";
import {
  createMcpMemoryService,
  type McpMemorySessionInfo,
  memoryScopesInputSchema,
  resolveMcpMemoryIdentity,
  rethrowMemoryError,
} from "./memory-shared";

export const RECALL_MCP_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

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
