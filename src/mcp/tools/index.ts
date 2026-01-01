/**
 * MCP tool registration and shared utilities.
 *
 * @module src/mcp/tools
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from '../server';
import { handleGet } from './get';
import { handleMultiGet } from './multi-get';
import { handleQuery } from './query';
import { handleSearch } from './search';
import { handleStatus } from './status';
import { handleVsearch } from './vsearch';

// ─────────────────────────────────────────────────────────────────────────────
// Shared Input Schemas
// ─────────────────────────────────────────────────────────────────────────────

const searchInputSchema = z.object({
  query: z.string().min(1, 'Query cannot be empty'),
  collection: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(5),
  minScore: z.number().min(0).max(1).optional(),
  lang: z.string().optional(),
});

const vsearchInputSchema = z.object({
  query: z.string().min(1, 'Query cannot be empty'),
  collection: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(5),
  minScore: z.number().min(0).max(1).optional(),
  lang: z.string().optional(),
});

const queryInputSchema = z.object({
  query: z.string().min(1, 'Query cannot be empty'),
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
  ref: z.string().min(1, 'Reference cannot be empty'),
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

// ─────────────────────────────────────────────────────────────────────────────
// Tool Result Type
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolResult {
  [x: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
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
      content: [{ type: 'text', text: 'Error: Server is shutting down' }],
    };
  }

  // Sequential execution via mutex
  const release = await ctx.toolMutex.acquire();
  try {
    const data = await fn();
    return {
      content: [{ type: 'text', text: formatText(data) }],
      structuredContent: data as { [x: string]: unknown },
    };
  } catch (e) {
    // Exception firewall: never throw, always return isError
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[MCP] ${name} error:`, message);
    return {
      isError: true,
      content: [{ type: 'text', text: `Error: ${message}` }],
    };
  } finally {
    release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerTools(server: McpServer, ctx: ToolContext): void {
  // Tool IDs use underscores (MCP pattern: ^[a-zA-Z0-9_-]{1,64}$)
  server.tool(
    'gno_search',
    'BM25 full-text search across indexed documents',
    searchInputSchema.shape,
    (args) => handleSearch(args, ctx)
  );

  server.tool(
    'gno_vsearch',
    'Vector/semantic similarity search',
    vsearchInputSchema.shape,
    (args) => handleVsearch(args, ctx)
  );

  server.tool(
    'gno_query',
    'Hybrid search with optional expansion and reranking',
    queryInputSchema.shape,
    (args) => handleQuery(args, ctx)
  );

  server.tool(
    'gno_get',
    'Retrieve a single document by URI, docid, or collection/path',
    getInputSchema.shape,
    (args) => handleGet(args, ctx)
  );

  server.tool(
    'gno_multi_get',
    'Retrieve multiple documents by refs or glob pattern',
    multiGetInputSchema.shape,
    (args) => handleMultiGet(args, ctx)
  );

  server.tool(
    'gno_status',
    'Get index status and health information',
    statusInputSchema.shape,
    (args) => handleStatus(args, ctx)
  );
}
