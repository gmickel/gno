/** Read-only MCP adapters for knowledge change, diff, and impact services. */

import { z } from "zod";

import type { ToolContext } from "../server";

import {
  analyzeKnowledgeImpact,
  getKnowledgeDiff,
  listKnowledgeChanges,
} from "../../core/knowledge-delta";
import { runTool, type ToolResult } from "./index";

export const changesInputSchema = z.object({
  since: z.string().trim().min(1).max(512).optional(),
  collection: z.string().trim().min(1).max(256).optional(),
  limit: z.number().int().min(1).max(1000).default(100),
});

export const diffInputSchema = z.object({
  ref: z.string().trim().min(1).max(4096),
  change: z.string().trim().min(1).max(512).optional(),
});

export const impactInputSchema = z.object({
  ref: z.string().trim().min(1).max(4096),
  maxDepth: z.number().int().min(1).max(6).default(3),
  maxNodes: z.number().int().min(1).max(1000).default(100),
  maxEdges: z.number().int().min(1).max(5000).default(250),
  frontierLimit: z.number().int().min(1).max(1000).default(100),
  visitedLimit: z.number().int().min(1).max(5000).default(500),
});

const unwrap = <T>(
  result:
    | { success: true; data: T }
    | { success: false; error: string; isValidation?: boolean }
): T => {
  if (result.success) return result.data;
  throw new Error(
    `${result.isValidation ? "VALIDATION" : "RUNTIME"}: ${result.error}`
  );
};

export const handleChanges = (
  args: z.infer<typeof changesInputSchema>,
  ctx: ToolContext
): Promise<ToolResult> =>
  runTool(
    ctx,
    "gno_changes",
    async () => unwrap(await listKnowledgeChanges(ctx.store, args)),
    (data) =>
      `${data.changes.length} retained document changes${data.page.truncated ? " (more available)" : ""}`
  );

export const handleDiff = (
  args: z.infer<typeof diffInputSchema>,
  ctx: ToolContext
): Promise<ToolResult> =>
  runTool(
    ctx,
    "gno_diff",
    async () =>
      unwrap(await getKnowledgeDiff(ctx.store, args.ref, args.change)),
    (data) =>
      `Structural diff for ${data.document.uri}: ${data.status}; history ${data.history.status}; source bodies not retained`
  );

export const handleImpact = (
  args: z.infer<typeof impactInputSchema>,
  ctx: ToolContext
): Promise<ToolResult> =>
  runTool(
    ctx,
    "gno_impact",
    async () => unwrap(await analyzeKnowledgeImpact(ctx.store, args.ref, args)),
    (data) =>
      `${data.impacted.length} documents depend on ${data.root.uri}${data.meta.truncated ? " (truncated)" : ""}`
  );
