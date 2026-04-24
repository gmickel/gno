/**
 * MCP tool registration and shared utilities.
 *
 * @module src/mcp/tools
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { z } from "zod";

import type { ToolContext } from "../server";

import { normalizeTag } from "../../core/tags";
import { handleAddCollection } from "./add-collection";
import { handleCapture } from "./capture";
import { handleClearCollectionEmbeddings } from "./clear-collection-embeddings";
import { handleEmbed } from "./embed";
import { handleGet } from "./get";
import { handleIndex } from "./index-cmd";
import { handleJobStatus } from "./job-status";
import {
  handleBacklinks,
  handleGraph,
  handleLinks,
  handleSimilar,
} from "./links";
import { handleListJobs } from "./list-jobs";
import { handleListTags } from "./list-tags";
import { handleMultiGet } from "./multi-get";
import { handleQuery } from "./query";
import { handleRemoveCollection } from "./remove-collection";
import { handleSearch } from "./search";
import { handleStatus } from "./status";
import { handleSync } from "./sync";
import { handleVsearch } from "./vsearch";
import {
  handleCreateFolder,
  handleDuplicateNote,
  handleMoveNote,
  handleRenameNote,
} from "./workspace-write";

// ─────────────────────────────────────────────────────────────────────────────
// Shared Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize and dedupe tag filter arrays.
 * Returns undefined if empty, normalized array otherwise.
 */
export function normalizeTagFilters(tags?: string[]): string[] | undefined {
  if (!tags?.length) return undefined;
  return [...new Set(tags.map(normalizeTag))];
}

export const MCP_TOOL_DESCRIPTIONS = {
  search:
    "BM25 keyword search. Fast exact-term lookup for names, identifiers, error text, and known phrases. Results include uri/docid and line when available; use gno_get with fromLine/lineCount or gno_multi_get for full context. Use gno_query when wording is uncertain.",
  vsearch:
    "Vector semantic search. Finds conceptually similar docs with different wording. Best after embeddings are current; use intent to disambiguate short terms. Use gno_query for default hybrid retrieval.",
  query:
    "Hybrid search (BM25 + vector + optional expansion/reranking). Recommended default. Use intent for ambiguous terms, queryModes to combine term/intent/hyde strategies, fast=true for quick lookup, thorough=true when recall matters, and candidateLimit to trade latency for coverage.",
  get: "Retrieve one document by gno:// URI, docid (#abc123), or collection/path. After search results include line, pass fromLine and lineCount to fetch only the relevant range before expanding to the full document.",
  multiGet:
    "Retrieve multiple documents by refs array or glob pattern. Use after gno_search/gno_query to batch top result URIs/docids; set maxBytes and lineNumbers to control context size.",
  status:
    "Get index health: collection count, document count, chunk count, embedding backlog, and per-collection stats. Check first when vector/hybrid results look stale or unavailable.",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Shared Input Schemas
// ─────────────────────────────────────────────────────────────────────────────

const searchInputSchema = z.object({
  query: z
    .string()
    .min(1, "Query cannot be empty")
    .describe(
      "Exact keyword, identifier, filename, error text, or phrase to match with BM25"
    ),
  collection: z
    .string()
    .optional()
    .describe("Filter to a single collection name"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(5)
    .describe("Max results to return"),
  minScore: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Minimum relevance score (0-1). Omit to return all matches"),
  lang: z
    .string()
    .optional()
    .describe(
      "BCP-47 language hint for tokenization (e.g. 'en', 'de'). Auto-detected if omitted"
    ),
  intent: z
    .string()
    .optional()
    .describe(
      "Disambiguating context for ambiguous queries; not searched directly (e.g. 'programming language' when query is 'python')"
    ),
  exclude: z
    .array(z.string())
    .optional()
    .describe("Exclude documents containing any of these terms"),
  since: z
    .string()
    .optional()
    .describe(
      "Only docs modified after this date (ISO format: 2026-03-01 or 2026-03-01T00:00:00)"
    ),
  until: z
    .string()
    .optional()
    .describe("Only docs modified before this date (ISO format)"),
  categories: z
    .array(z.string())
    .optional()
    .describe("Require category match (from document frontmatter)"),
  author: z
    .string()
    .optional()
    .describe("Filter by author (case-insensitive substring match)"),
  tagsAll: z
    .array(z.string())
    .optional()
    .describe("Require ALL of these tags (AND filter)"),
  tagsAny: z
    .array(z.string())
    .optional()
    .describe("Require ANY of these tags (OR filter)"),
});

const captureInputSchema = z.object({
  collection: z
    .string()
    .min(1, "Collection cannot be empty")
    .describe("Target collection name (must already exist)"),
  content: z
    .string()
    .optional()
    .describe(
      "Document content (markdown or plain text). Optional when presetId provides a scaffold."
    ),
  title: z
    .string()
    .optional()
    .describe("Document title. Auto-derived from content if omitted"),
  path: z
    .string()
    .optional()
    .describe(
      "Relative path within collection (e.g. 'notes/meeting.md'). Auto-generated from title if omitted"
    ),
  folderPath: z
    .string()
    .optional()
    .describe("Optional folder path within the collection"),
  collisionPolicy: z
    .enum(["error", "open_existing", "create_with_suffix"])
    .optional()
    .describe("How to handle name collisions"),
  presetId: z
    .enum([
      "blank",
      "project-note",
      "research-note",
      "decision-note",
      "prompt-pattern",
      "source-summary",
    ])
    .optional()
    .describe("Optional note preset scaffold"),
  overwrite: z
    .boolean()
    .default(false)
    .describe("Overwrite if file already exists at path"),
  tags: z
    .array(z.string())
    .optional()
    .describe("Tags to apply to the new document"),
});

const addCollectionInputSchema = z.object({
  path: z
    .string()
    .min(1, "Path cannot be empty")
    .describe("Absolute path to the directory to index"),
  name: z
    .string()
    .optional()
    .describe("Collection name. Auto-derived from directory name if omitted"),
  pattern: z
    .string()
    .optional()
    .describe(
      "Glob pattern for files to include (default: '**/*'). E.g. '**/*.md' for markdown only"
    ),
  include: z
    .array(z.string())
    .optional()
    .describe("Extension allowlist (e.g. ['.md', '.pdf', '.docx'])"),
  exclude: z
    .array(z.string())
    .optional()
    .describe("Glob patterns to exclude (default: ['.git', 'node_modules'])"),
  gitPull: z
    .boolean()
    .default(false)
    .describe("Run git pull before indexing (if collection is a git repo)"),
});

const syncInputSchema = z.object({
  collection: z
    .string()
    .optional()
    .describe("Collection name to sync. Omit to sync all collections"),
  gitPull: z.boolean().default(false).describe("Run git pull before syncing"),
  runUpdateCmd: z
    .boolean()
    .default(false)
    .describe("Run the collection's configured update command before syncing"),
});

const embedInputSchema = z.object({
  collection: z
    .string()
    .optional()
    .describe("Collection name to embed. Omit to embed all collections"),
});

const indexInputSchema = z.object({
  collection: z
    .string()
    .optional()
    .describe("Collection name to index. Omit to index all collections"),
  gitPull: z.boolean().default(false).describe("Run git pull before indexing"),
});

const removeCollectionInputSchema = z.object({
  collection: z
    .string()
    .min(1, "Collection cannot be empty")
    .describe("Collection name to remove"),
});

const clearCollectionEmbeddingsInputSchema = z.object({
  collection: z
    .string()
    .min(1, "Collection cannot be empty")
    .describe("Collection name to clean"),
  mode: z
    .enum(["stale", "all"])
    .default("stale")
    .describe("Cleanup mode: stale models only, or all embeddings"),
});

const createFolderInputSchema = z.object({
  collection: z.string().min(1, "Collection cannot be empty"),
  name: z.string().min(1, "Folder name cannot be empty"),
  parentPath: z.string().optional(),
});

const renameNoteInputSchema = z.object({
  ref: z.string().min(1, "ref cannot be empty"),
  name: z.string().min(1, "name cannot be empty"),
});

const moveNoteInputSchema = z.object({
  ref: z.string().min(1, "ref cannot be empty"),
  folderPath: z.string().min(1, "folderPath cannot be empty"),
  name: z.string().optional(),
});

const duplicateNoteInputSchema = z.object({
  ref: z.string().min(1, "ref cannot be empty"),
  folderPath: z.string().optional(),
  name: z.string().optional(),
});

const vsearchInputSchema = z.object({
  query: z
    .string()
    .min(1, "Query cannot be empty")
    .describe(
      "Natural-language concept to match semantically; use gno_search for exact error text or identifiers"
    ),
  collection: z
    .string()
    .optional()
    .describe("Filter to a single collection name"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(5)
    .describe("Max results to return"),
  minScore: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Minimum similarity score (0-1)"),
  lang: z
    .string()
    .optional()
    .describe("BCP-47 language hint (e.g. 'en', 'de')"),
  intent: z
    .string()
    .optional()
    .describe(
      "Disambiguating context for ambiguous terms; steers snippet choice without becoming the searched text"
    ),
  exclude: z
    .array(z.string())
    .optional()
    .describe("Exclude documents containing any of these terms"),
  since: z
    .string()
    .optional()
    .describe("Only docs modified after this date (ISO format)"),
  until: z
    .string()
    .optional()
    .describe("Only docs modified before this date (ISO format)"),
  categories: z.array(z.string()).optional().describe("Require category match"),
  author: z
    .string()
    .optional()
    .describe("Filter by author (case-insensitive substring)"),
  tagsAll: z.array(z.string()).optional().describe("Require ALL of these tags"),
  tagsAny: z.array(z.string()).optional().describe("Require ANY of these tags"),
});

const queryModeInputSchema = z.object({
  mode: z
    .enum(["term", "intent", "hyde"])
    .describe(
      "Retrieval strategy: 'term' for exact lexical anchors, 'intent' for disambiguation, 'hyde' for one hypothetical answer/document to improve semantic matching"
    ),
  text: z
    .string()
    .trim()
    .min(1, "Query mode text cannot be empty")
    .describe(
      "Text for this query mode; keep term modes concise and hyde modes answer-shaped"
    ),
});

export const queryInputSchema = z.object({
  query: z
    .string()
    .min(1, "Query cannot be empty")
    .describe(
      "Primary user query; combine with intent or queryModes for ambiguous requests"
    ),
  collection: z
    .string()
    .optional()
    .describe("Filter to a single collection name"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(5)
    .describe("Max results to return"),
  minScore: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Minimum relevance score (0-1)"),
  lang: z
    .string()
    .optional()
    .describe(
      "BCP-47 language hint (e.g. 'en', 'de'). Auto-detected if omitted"
    ),
  intent: z
    .string()
    .optional()
    .describe(
      "Disambiguating context (e.g. 'programming language' when query is 'python'); steers expansion, rerank, and snippet choice"
    ),
  candidateLimit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "Max candidates passed to reranking stage; raise when top results miss relevant docs, lower for latency"
    ),
  exclude: z
    .array(z.string())
    .optional()
    .describe("Exclude documents containing any of these terms"),
  since: z
    .string()
    .optional()
    .describe("Only docs modified after this date (ISO format)"),
  until: z
    .string()
    .optional()
    .describe("Only docs modified before this date (ISO format)"),
  categories: z.array(z.string()).optional().describe("Require category match"),
  author: z
    .string()
    .optional()
    .describe("Filter by author (case-insensitive substring)"),
  queryModes: z
    .array(queryModeInputSchema)
    .describe(
      "Structured query modes for typed retrieval: combine term anchors, intent disambiguation, and at most one hyde hypothetical document"
    )
    .superRefine((entries, ctx) => {
      const hydeCount = entries.filter((entry) => entry.mode === "hyde").length;
      if (hydeCount > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Only one hyde mode is allowed in queryModes",
        });
      }
    })
    .optional(),
  fast: z
    .boolean()
    .default(false)
    .describe("Skip expansion and reranking (~0.7s). Use for quick lookups"),
  thorough: z
    .boolean()
    .default(false)
    .describe(
      "Enable query expansion for best recall (~5-8s). Use for broad research or when default results miss likely docs"
    ),
  expand: z
    .boolean()
    .optional()
    .describe("Override: enable/disable query expansion"),
  rerank: z
    .boolean()
    .optional()
    .describe("Override: enable/disable cross-encoder reranking"),
  tagsAll: z.array(z.string()).optional().describe("Require ALL of these tags"),
  tagsAny: z.array(z.string()).optional().describe("Require ANY of these tags"),
});

const getInputSchema = z.object({
  ref: z
    .string()
    .min(1, "Reference cannot be empty")
    .describe(
      "Document reference: URI (gno://collection/path), docid (#abc123), or collection/path"
    ),
  fromLine: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Start reading from this line number; use the line returned by search/query results"
    ),
  lineCount: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Number of lines to return from fromLine; prefer a small range before fetching full docs"
    ),
  lineNumbers: z
    .boolean()
    .default(true)
    .describe("Include line numbers in output"),
});

const multiGetInputSchema = z.object({
  refs: z
    .array(z.string())
    .min(1)
    .optional()
    .describe(
      "Array of document references from search/query results (gno:// URIs or docids)"
    ),
  pattern: z
    .string()
    .optional()
    .describe("Glob pattern to match documents (e.g. 'work/**/*.md')"),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .default(10_240)
    .describe(
      "Max bytes per document; lower this when batching many top search results"
    ),
  lineNumbers: z
    .boolean()
    .default(true)
    .describe("Include line numbers in output"),
});

const statusInputSchema = z.object({});

const jobStatusInputSchema = z.object({
  jobId: z
    .string()
    .min(1, "Job ID cannot be empty")
    .describe("Job ID returned by async operations (embed, index)"),
});

const listJobsInputSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10)
    .describe("Max jobs to return"),
});

const listTagsInputSchema = z.object({
  collection: z
    .string()
    .optional()
    .describe("Filter tags to a single collection"),
  prefix: z
    .string()
    .optional()
    .describe("Filter tags by prefix (e.g. 'project/' for hierarchical tags)"),
});

const linksInputSchema = z.object({
  ref: z
    .string()
    .trim()
    .min(1, "Reference cannot be empty")
    .describe("Document reference (URI, docid, or collection/path)"),
  type: z
    .enum(["wiki", "markdown"])
    .optional()
    .describe(
      "Filter by link type: 'wiki' ([[links]]) or 'markdown' ([links](url))"
    ),
});

const backlinksInputSchema = z.object({
  ref: z
    .string()
    .trim()
    .min(1, "Reference cannot be empty")
    .describe("Document reference to find backlinks for"),
  collection: z
    .string()
    .trim()
    .optional()
    .describe("Filter backlinks to a single collection"),
});

const similarInputSchema = z.object({
  ref: z
    .string()
    .trim()
    .min(1, "Reference cannot be empty")
    .describe("Document reference to find similar docs for"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(5)
    .describe("Max similar documents to return"),
  threshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Minimum similarity score (0-1, default: 0.7)"),
  crossCollection: z
    .boolean()
    .default(false)
    .describe(
      "Search across all collections (not just the document's own collection)"
    ),
});

const graphInputSchema = z.object({
  collection: z
    .string()
    .trim()
    .optional()
    .describe("Filter graph to a single collection"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .default(2000)
    .describe("Max nodes in graph"),
  edgeLimit: z
    .number()
    .int()
    .min(1)
    .max(50000)
    .default(10000)
    .describe("Max edges in graph"),
  includeSimilar: z
    .boolean()
    .default(false)
    .describe("Include vector-similarity edges (not just wiki/markdown links)"),
  threshold: z
    .number()
    .min(0)
    .max(1)
    .default(0.7)
    .describe("Similarity threshold for similar edges (0-1)"),
  linkedOnly: z
    .boolean()
    .default(true)
    .describe("Exclude isolated nodes (no links)"),
  similarTopK: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe("Max similar docs per node when includeSimilar=true"),
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

/**
 * Run a tool without acquiring the mutex.
 * For read-only in-memory tools (job_status, list_jobs) that should not block.
 * Fixes mutex starvation where status queries block while jobs run.
 */
export async function runToolNoMutex<T>(
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
    MCP_TOOL_DESCRIPTIONS.search,
    searchInputSchema.shape,
    (args) => handleSearch(args, ctx)
  );

  server.tool(
    "gno_vsearch",
    MCP_TOOL_DESCRIPTIONS.vsearch,
    vsearchInputSchema.shape,
    (args) => handleVsearch(args, ctx)
  );

  server.tool(
    "gno_query",
    MCP_TOOL_DESCRIPTIONS.query,
    queryInputSchema.shape,
    (args) => handleQuery(args, ctx)
  );

  server.tool(
    "gno_get",
    MCP_TOOL_DESCRIPTIONS.get,
    getInputSchema.shape,
    (args) => handleGet(args, ctx)
  );

  server.tool(
    "gno_multi_get",
    MCP_TOOL_DESCRIPTIONS.multiGet,
    multiGetInputSchema.shape,
    (args) => handleMultiGet(args, ctx)
  );

  server.tool(
    "gno_status",
    MCP_TOOL_DESCRIPTIONS.status,
    statusInputSchema.shape,
    (args) => handleStatus(args, ctx)
  );

  server.tool(
    "gno_list_tags",
    "List all tags with document counts. Use prefix to filter hierarchical tags (e.g. 'project/').",
    listTagsInputSchema.shape,
    (args) => handleListTags(args, ctx)
  );

  server.tool(
    "gno_links",
    "Get outgoing wiki ([[links]]) and markdown links from a document.",
    linksInputSchema.shape,
    (args) => handleLinks(args, ctx)
  );

  server.tool(
    "gno_backlinks",
    "Find all documents that link TO a given document (incoming references).",
    backlinksInputSchema.shape,
    (args) => handleBacklinks(args, ctx)
  );

  server.tool(
    "gno_similar",
    "Find semantically similar documents using vector embeddings. Requires embeddings to exist for source document.",
    similarInputSchema.shape,
    (args) => handleSimilar(args, ctx)
  );

  server.tool(
    "gno_graph",
    "Get knowledge graph of document connections (wiki links, markdown links, optional similarity edges).",
    graphInputSchema.shape,
    (args) => handleGraph(args, ctx)
  );

  if (ctx.enableWrite) {
    server.tool(
      "gno_capture",
      "Create a new document in a collection. Writes to disk. Does NOT auto-embed; run gno_index after to make it searchable via vector search.",
      captureInputSchema.shape,
      (args) => handleCapture(args, ctx)
    );

    server.tool(
      "gno_add_collection",
      "Add a directory as a new collection and start indexing. Returns a job ID for tracking.",
      addCollectionInputSchema.shape,
      (args) => handleAddCollection(args, ctx)
    );

    server.tool(
      "gno_sync",
      "Sync files from disk into the index (FTS only, no embeddings). Does NOT auto-embed; run gno_embed after if vector search needed.",
      syncInputSchema.shape,
      (args) => handleSync(args, ctx)
    );

    server.tool(
      "gno_embed",
      "Generate vector embeddings for all unembedded chunks, optionally scoped to one collection. Async: returns a job ID. Poll with gno_job_status.",
      embedInputSchema.shape,
      (args) => handleEmbed(args, ctx)
    );

    server.tool(
      "gno_index",
      "Full index: sync files from disk + generate embeddings. Async: returns a job ID. Poll with gno_job_status.",
      indexInputSchema.shape,
      (args) => handleIndex(args, ctx)
    );

    server.tool(
      "gno_remove_collection",
      "Remove a collection from config and delete its indexed data.",
      removeCollectionInputSchema.shape,
      (args) => handleRemoveCollection(args, ctx)
    );

    server.tool(
      "gno_clear_collection_embeddings",
      "Remove stale or all embeddings for one collection.",
      clearCollectionEmbeddingsInputSchema.shape,
      (args) => handleClearCollectionEmbeddings(args, ctx)
    );

    server.tool(
      "gno_create_folder",
      "Create a folder inside an existing collection.",
      createFolderInputSchema.shape,
      (args) => handleCreateFolder(args, ctx)
    );

    server.tool(
      "gno_rename_note",
      "Rename an editable note in place.",
      renameNoteInputSchema.shape,
      (args) => handleRenameNote(args, ctx)
    );

    server.tool(
      "gno_move_note",
      "Move an editable note to another folder in the same collection.",
      moveNoteInputSchema.shape,
      (args) => handleMoveNote(args, ctx)
    );

    server.tool(
      "gno_duplicate_note",
      "Duplicate an editable note into the current or another folder.",
      duplicateNoteInputSchema.shape,
      (args) => handleDuplicateNote(args, ctx)
    );
  }

  server.tool(
    "gno_job_status",
    "Check status of an async job (embed, index). Returns progress percentage and completion state.",
    jobStatusInputSchema.shape,
    (args) => handleJobStatus(args, ctx)
  );

  server.tool(
    "gno_list_jobs",
    "List active and recently completed async jobs with their status and progress.",
    listJobsInputSchema.shape,
    (args) => handleListJobs(args, ctx)
  );
}
