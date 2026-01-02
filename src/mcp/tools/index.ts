/**
 * MCP tool registration and shared utilities.
 *
 * @module src/mcp/tools
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { z } from "zod";

import type { ToolContext } from "../server";

import { handleAddCollection } from "./add-collection";
import { handleCapture } from "./capture";
import { handleGet } from "./get";
import { handleJobStatus } from "./job-status";
import { handleListJobs } from "./list-jobs";
import { handleMultiGet } from "./multi-get";
import { handleQuery } from "./query";
import { handleRemoveCollection } from "./remove-collection";
import { handleSearch } from "./search";
import { handleStatus } from "./status";
import { handleSync } from "./sync";
import { handleVsearch } from "./vsearch";

// ─────────────────────────────────────────────────────────────────────────────
// Shared Input Schemas
// ─────────────────────────────────────────────────────────────────────────────

const searchInputSchema = z.object({
  query: z.string().min(1, "Query cannot be empty"),
  collection: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(5),
  minScore: z.number().min(0).max(1).optional(),
  lang: z.string().optional(),
});

const captureInputSchema = z.object({
  collection: z.string().min(1, "Collection cannot be empty"),
  content: z.string(),
  title: z.string().optional(),
  path: z.string().optional(),
  overwrite: z.boolean().default(false),
});

const addCollectionInputSchema = z.object({
  path: z.string().min(1, "Path cannot be empty"),
  name: z.string().optional(),
  pattern: z.string().optional(),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  gitPull: z.boolean().default(false),
});

const syncInputSchema = z.object({
  collection: z.string().optional(),
  gitPull: z.boolean().default(false),
  runUpdateCmd: z.boolean().default(false),
});

const removeCollectionInputSchema = z.object({
  collection: z.string().min(1, "Collection cannot be empty"),
});

const vsearchInputSchema = z.object({
  query: z.string().min(1, "Query cannot be empty"),
  collection: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(5),
  minScore: z.number().min(0).max(1).optional(),
  lang: z.string().optional(),
});

const queryInputSchema = z.object({
  query: z.string().min(1, "Query cannot be empty"),
  collection: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(5),
  minScore: z.number().min(0).max(1).optional(),
  lang: z.string().optional(),
  fast: z.boolean().default(false),
  thorough: z.boolean().default(false),
  expand: z.boolean().default(false), // Default: skip expansion
  rerank: z.boolean().default(true),
});

const getInputSchema = z.object({
  ref: z.string().min(1, "Reference cannot be empty"),
  fromLine: z.number().int().min(1).optional(),
  lineCount: z.number().int().min(1).optional(),
  lineNumbers: z.boolean().default(true),
});

const multiGetInputSchema = z.object({
  refs: z.array(z.string()).min(1).optional(),
  pattern: z.string().optional(),
  maxBytes: z.number().int().min(1).default(10_240),
  lineNumbers: z.boolean().default(true),
});

const statusInputSchema = z.object({});

const jobStatusInputSchema = z.object({
  jobId: z.string().min(1, "Job ID cannot be empty"),
});

const listJobsInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(10),
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool Result Type
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolResult {
  [x: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: { [x: string]: unknown };
  isError?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// DRY Helper: Exception Firewall + Mutex + Response Shaping
// ─────────────────────────────────────────────────────────────────────────────

export async function runTool<T>(
  ctx: ToolContext,
  name: string,
  fn: () => Promise<T>,
  formatText: (data: T) => string
): Promise<ToolResult> {
  // Check shutdown
  if (ctx.isShuttingDown()) {
    return {
      isError: true,
      content: [{ type: "text", text: "Error: Server is shutting down" }],
    };
  }

  // Sequential execution via mutex
  const release = await ctx.toolMutex.acquire();
  try {
    const data = await fn();
    return {
      content: [{ type: "text", text: formatText(data) }],
      structuredContent: data as { [x: string]: unknown },
    };
  } catch (e) {
    // Exception firewall: never throw, always return isError
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[MCP] ${name} error:`, message);
    const parsedError = parseErrorMessage(message);
    return {
      isError: true,
      content: [{ type: "text", text: `Error: ${message}` }],
      structuredContent: parsedError,
    };
  } finally {
    release();
  }
}

function parseErrorMessage(message: string): { [x: string]: unknown } {
  const match = message.match(/^([A-Z_]+):\s*(.*)$/);
  if (match) {
    return {
      error: match[1],
      message: match[2] || message,
    };
  }
  return {
    error: "RUNTIME",
    message,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerTools(server: McpServer, ctx: ToolContext): void {
  // Tool IDs use underscores (MCP pattern: ^[a-zA-Z0-9_-]{1,64}$)
  server.tool(
    "gno_search",
    "BM25 full-text search across indexed documents",
    searchInputSchema.shape,
    (args) => handleSearch(args, ctx)
  );

  server.tool(
    "gno_vsearch",
    "Vector/semantic similarity search",
    vsearchInputSchema.shape,
    (args) => handleVsearch(args, ctx)
  );

  server.tool(
    "gno_query",
    "Hybrid search with optional expansion and reranking",
    queryInputSchema.shape,
    (args) => handleQuery(args, ctx)
  );

  server.tool(
    "gno_get",
    "Retrieve a single document by URI, docid, or collection/path",
    getInputSchema.shape,
    (args) => handleGet(args, ctx)
  );

  server.tool(
    "gno_multi_get",
    "Retrieve multiple documents by refs or glob pattern",
    multiGetInputSchema.shape,
    (args) => handleMultiGet(args, ctx)
  );

  server.tool(
    "gno_status",
    "Get index status and health information",
    statusInputSchema.shape,
    (args) => handleStatus(args, ctx)
  );

  if (ctx.enableWrite) {
    server.tool(
      "gno_capture",
      "Create a new document",
      captureInputSchema.shape,
      (args) => handleCapture(args, ctx)
    );

    server.tool(
      "gno_add_collection",
      "Add a collection and start indexing",
      addCollectionInputSchema.shape,
      (args) => handleAddCollection(args, ctx)
    );

    server.tool(
      "gno_sync",
      "Sync one or all collections",
      syncInputSchema.shape,
      (args) => handleSync(args, ctx)
    );

    server.tool(
      "gno_remove_collection",
      "Remove a collection from config",
      removeCollectionInputSchema.shape,
      (args) => handleRemoveCollection(args, ctx)
    );
  }

  server.tool(
    "gno_job_status",
    "Get status of an async job",
    jobStatusInputSchema.shape,
    (args) => handleJobStatus(args, ctx)
  );

  server.tool(
    "gno_list_jobs",
    "List active and recent jobs",
    listJobsInputSchema.shape,
    (args) => handleListJobs(args, ctx)
  );
}
