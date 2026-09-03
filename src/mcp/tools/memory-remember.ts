/**
 * MCP gno_remember tool - store one fact with supersession semantics.
 *
 * Thin adapter over the core `MemoryService`, registered only with
 * `--enable-write`. The service acquires the shared write lease itself; this
 * module performs no lock acquisition.
 *
 * @module src/mcp/tools/memory-remember
 */

import { z } from "zod";

import type { ToolContext } from "../server";

import { type RememberResult } from "../../core/memory";
import { MEMORY_MAX_FACT_BYTES } from "../../core/memory-record";
import { runTool, type ToolResult } from "./index";
import {
  createMcpMemoryService,
  type McpMemorySessionInfo,
  memoryScopesInputSchema,
  resolveMcpMemoryIdentity,
  rethrowMemoryError,
} from "./memory-shared";

export const REMEMBER_MCP_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export const memoryReceiptInputSchema = z
  .object({
    caller: z.string(),
    session: z.string(),
    issuedAt: z.string(),
    memoryIds: z.array(z.string()),
    spanHashes: z.array(z.string()),
    digest: z.string(),
  })
  .describe(
    "The receipt from the gno_recall response the fact was derived from, if any; replayed recalled spans are rejected"
  );

export const rememberInputSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1, "Fact text cannot be empty")
    .max(MEMORY_MAX_FACT_BYTES)
    .describe(
      "One fact, stated in full (single statement, not a document; use gno_capture for documents)"
    ),
  collection: z
    .string()
    .trim()
    .min(1, "Collection cannot be empty")
    .describe("Memory-managed collection to write into"),
  scopes: memoryScopesInputSchema,
  decision: z
    .enum(["add", "supersede"])
    .optional()
    .describe(
      "Omit to receive candidates without writing; add creates a new fact; supersede replaces predecessorUri"
    ),
  predecessorUri: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("gno:// URI of the fact being superseded (supersede only)"),
  predecessorHash: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "contentHash of the predecessor as returned by gno_recall (supersede only)"
    ),
  receipt: memoryReceiptInputSchema.optional(),
  derivedFrom: z
    .array(z.string().trim().min(1))
    .max(32)
    .optional()
    .describe(
      "Declared origins of the fact; any gno:// origin is rejected as GNO-derived"
    ),
  source: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Free-text evidence for the fact (where it came from)"),
});

export type RememberToolInput = z.infer<typeof rememberInputSchema>;

export function formatRememberResult(result: RememberResult): string {
  const lines: string[] = [];
  const matching = `matching: ${result.matching.mode} (threshold ${result.matching.threshold}${
    result.matching.semanticUnavailable
      ? `, ${result.matching.semanticUnavailable}`
      : ""
  })`;
  switch (result.outcome) {
    case "existing":
      lines.push(`Outcome: existing (exact duplicate, nothing written)`);
      lines.push(`URI: ${result.record.uri}`);
      lines.push(`Hash: ${result.record.contentHash}`);
      break;
    case "candidates":
      lines.push(
        `Outcome: candidates (${result.candidates.length}, nothing written). Decide: decision=add for a new fact, or decision=supersede with predecessorUri + predecessorHash.`
      );
      for (const candidate of result.candidates) {
        lines.push(
          `- [${candidate.match} ${candidate.similarity.toFixed(2)}] ${candidate.text}`
        );
        lines.push(`  uri: ${candidate.uri} | hash: ${candidate.contentHash}`);
      }
      break;
    default:
      lines.push(`Outcome: ${result.outcome}`);
      lines.push(`URI: ${result.record.uri}`);
      lines.push(`Hash: ${result.record.contentHash}`);
      lines.push(`Path: ${result.absPath}`);
      lines.push(`Sync: ${result.sync.status}`);
      if (result.record.supersedes.length > 0) {
        lines.push(`Supersedes: ${result.record.supersedes.join(", ")}`);
      }
      break;
  }
  lines.push(matching);
  return lines.join("\n");
}

export function handleRemember(
  args: RememberToolInput,
  ctx: ToolContext,
  info: McpMemorySessionInfo = {}
): Promise<ToolResult> {
  return runTool(
    ctx,
    "gno_remember",
    async () => {
      if (!ctx.enableWrite) {
        throw new Error(
          "WRITE_DISABLED: gno_remember requires --enable-write or GNO_MCP_ENABLE_WRITE=1"
        );
      }
      const service = createMcpMemoryService(ctx);
      let result: RememberResult;
      try {
        result = await service.remember({
          ...resolveMcpMemoryIdentity(ctx, info),
          text: args.text,
          collection: args.collection,
          scopes: args.scopes,
          decision: args.decision,
          predecessorUri: args.predecessorUri,
          predecessorHash: args.predecessorHash,
          receipt: args.receipt,
          derivedFrom: args.derivedFrom,
          source: args.source,
        });
      } catch (error) {
        return rethrowMemoryError(error);
      }
      if (result.outcome === "added" || result.outcome === "superseded") {
        ctx.markContentMutation?.();
      }
      return result;
    },
    formatRememberResult
  );
}
