/**
 * REST API routes for GNO web UI.
 * All routes return JSON with consistent error format.
 *
 * @module src/serve/routes/api
 */

import type { Config, ModelPreset } from "../../config/types";
import type { AskResult, Citation, SearchOptions } from "../../pipeline/types";
import type { SqliteAdapter } from "../../store/sqlite/adapter";

import { modelsPull } from "../../cli/commands/models/pull";
import { addCollection, removeCollection } from "../../collection";
import { atomicWrite } from "../../core/file-ops";
import {
  normalizeTag,
  parseAndValidateTagFilter,
  validateTag,
} from "../../core/tags";
import { validateRelPath } from "../../core/validation";
import { defaultSyncService, type SyncResult } from "../../ingestion";
import { updateFrontmatterTags } from "../../ingestion/frontmatter";
import { getModelConfig, getPreset, listPresets } from "../../llm/registry";
import {
  generateGroundedAnswer,
  processAnswerResult,
} from "../../pipeline/answer";
import { searchHybrid } from "../../pipeline/hybrid";
import { searchBm25 } from "../../pipeline/search";
import { applyConfigChange } from "../config-sync";
import {
  downloadState,
  reloadServerContext,
  resetDownloadState,
  type ServerContext,
} from "../context";
import { getJobStatus, startJob } from "../jobs";

/** Mutable context holder for hot-reloading presets */
export interface ContextHolder {
  current: ServerContext;
  config: Config;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

export interface SearchRequestBody {
  query: string;
  // Only BM25 supported in web UI (vector/hybrid require LLM deps)
  limit?: number;
  minScore?: number;
  collection?: string;
  /** Comma-separated tags - filter to docs having ALL (AND) */
  tagsAll?: string;
  /** Comma-separated tags - filter to docs having ANY (OR) */
  tagsAny?: string;
}

export interface QueryRequestBody {
  query: string;
  limit?: number;
  minScore?: number;
  collection?: string;
  lang?: string;
  noExpand?: boolean;
  noRerank?: boolean;
  /** Comma-separated tags - filter to docs having ALL (AND) */
  tagsAll?: string;
  /** Comma-separated tags - filter to docs having ANY (OR) */
  tagsAny?: string;
}

export interface AskRequestBody {
  query: string;
  limit?: number;
  collection?: string;
  lang?: string;
  maxAnswerTokens?: number;
  noExpand?: boolean;
  noRerank?: boolean;
  /** Comma-separated tags - filter to docs having ALL (AND) */
  tagsAll?: string;
  /** Comma-separated tags - filter to docs having ANY (OR) */
  tagsAny?: string;
}

export interface CreateCollectionRequestBody {
  path: string;
  name?: string;
  pattern?: string;
  include?: string;
  exclude?: string;
  gitPull?: boolean;
}

export interface SyncRequestBody {
  collection?: string;
  gitPull?: boolean;
}

export interface CreateDocRequestBody {
  collection: string;
  relPath: string;
  content: string;
  overwrite?: boolean;
  /** Tags to add to document (written to frontmatter for markdown) */
  tags?: string[];
}

export interface UpdateDocRequestBody {
  /** New content (optional if only updating tags) */
  content?: string;
  /** Tags to set (replaces existing tags) */
  tags?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function errorResponse(code: string, message: string, status = 400): Response {
  return jsonResponse({ error: { code, message } }, status);
}

// ─────────────────────────────────────────────────────────────────────────────
// Route Handlers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/health
 * Health check endpoint.
 */
export function handleHealth(): Response {
  return jsonResponse({ ok: true });
}

/**
 * GET /api/status
 * Returns index status matching status.schema.json.
 */
export async function handleStatus(store: SqliteAdapter): Promise<Response> {
  const result = await store.getStatus();
  if (!result.ok) {
    return errorResponse("RUNTIME", result.error.message, 500);
  }

  const s = result.value;
  return jsonResponse({
    indexName: s.indexName,
    configPath: s.configPath,
    dbPath: s.dbPath,
    collections: s.collections.map((c) => ({
      name: c.name,
      path: c.path,
      documentCount: c.activeDocuments,
      chunkCount: c.totalChunks,
      embeddedCount: c.embeddedChunks,
    })),
    totalDocuments: s.activeDocuments,
    totalChunks: s.totalChunks,
    embeddingBacklog: s.embeddingBacklog,
    lastUpdated: s.lastUpdatedAt,
    healthy: s.healthy,
  });
}

/**
 * GET /api/collections
 * Returns list of collections.
 */
export async function handleCollections(
  store: SqliteAdapter
): Promise<Response> {
  const result = await store.getCollections();
  if (!result.ok) {
    return errorResponse("RUNTIME", result.error.message, 500);
  }

  return jsonResponse(
    result.value.map((c) => ({
      name: c.name,
      path: c.path,
    }))
  );
}

/**
 * POST /api/collections
 * Create a new collection and start sync job.
 */
export async function handleCreateCollection(
  ctxHolder: ContextHolder,
  store: SqliteAdapter,
  req: Request
): Promise<Response> {
  let body: CreateCollectionRequestBody;
  try {
    body = (await req.json()) as CreateCollectionRequestBody;
  } catch {
    return errorResponse("VALIDATION", "Invalid JSON body");
  }

  // Validate required fields
  if (!body.path || typeof body.path !== "string") {
    return errorResponse("VALIDATION", "Missing or invalid path");
  }

  // Validate optional fields have correct types
  if (body.name !== undefined && typeof body.name !== "string") {
    return errorResponse("VALIDATION", "name must be a string");
  }
  if (body.pattern !== undefined && typeof body.pattern !== "string") {
    return errorResponse("VALIDATION", "pattern must be a string");
  }
  if (
    body.include !== undefined &&
    typeof body.include !== "string" &&
    !Array.isArray(body.include)
  ) {
    return errorResponse("VALIDATION", "include must be a string or array");
  }
  if (
    body.exclude !== undefined &&
    typeof body.exclude !== "string" &&
    !Array.isArray(body.exclude)
  ) {
    return errorResponse("VALIDATION", "exclude must be a string or array");
  }
  if (body.gitPull !== undefined && typeof body.gitPull !== "boolean") {
    return errorResponse("VALIDATION", "gitPull must be a boolean");
  }

  // Derive name from path if not provided
  const path = await import("node:path"); // no bun equivalent
  const name = body.name || path.basename(body.path);

  // Persist config and sync to DB (mutation happens inside with fresh config)
  const syncResult = await applyConfigChange(ctxHolder, store, async (cfg) => {
    const addResult = await addCollection(cfg, {
      path: body.path,
      name,
      pattern: body.pattern,
      include: body.include,
      exclude: body.exclude,
    });

    if (!addResult.ok) {
      return { ok: false, error: addResult.message, code: addResult.code };
    }
    return { ok: true, config: addResult.config };
  });
  if (!syncResult.ok) {
    // Map mutation error codes to HTTP status codes
    const statusMap: Record<string, number> = {
      DUPLICATE: 409,
      PATH_NOT_FOUND: 400,
    };
    const status = statusMap[syncResult.code] ?? 500;
    return errorResponse(syncResult.code, syncResult.error, status);
  }

  // Find the newly added collection from config
  const collection = syncResult.config.collections.find((c) => c.name === name);
  if (!collection) {
    return errorResponse("RUNTIME", "Collection not found after add", 500);
  }
  const jobResult = startJob("add", async (): Promise<SyncResult> => {
    const result = await defaultSyncService.syncCollection(collection, store, {
      gitPull: body.gitPull,
      runUpdateCmd: true,
    });
    return {
      collections: [result],
      totalDurationMs: result.durationMs,
      totalFilesProcessed: result.filesProcessed,
      totalFilesAdded: result.filesAdded,
      totalFilesUpdated: result.filesUpdated,
      totalFilesErrored: result.filesErrored,
      totalFilesSkipped: result.filesSkipped,
    };
  });

  if (!jobResult.ok) {
    return errorResponse("CONFLICT", jobResult.error, 409);
  }

  return jsonResponse(
    {
      jobId: jobResult.jobId,
      collection: { name: collection.name, path: collection.path },
    },
    202
  );
}

/**
 * DELETE /api/collections/:name
 * Remove a collection from config.
 * Note: Does NOT remove indexed documents - they remain in DB until re-sync
 * or manual cleanup. This preserves data for potential recovery.
 */
export async function handleDeleteCollection(
  ctxHolder: ContextHolder,
  store: SqliteAdapter,
  name: string
): Promise<Response> {
  // Persist config and sync to DB (mutation happens inside with fresh config)
  const syncResult = await applyConfigChange(ctxHolder, store, (cfg) => {
    const removeResult = removeCollection(cfg, { name });

    if (!removeResult.ok) {
      return {
        ok: false,
        error: removeResult.message,
        code: removeResult.code,
      };
    }
    return { ok: true, config: removeResult.config };
  });

  if (!syncResult.ok) {
    // Map mutation error codes to HTTP status codes
    const statusMap: Record<string, number> = {
      NOT_FOUND: 404,
      HAS_REFERENCES: 400,
    };
    const status = statusMap[syncResult.code] ?? 500;
    return errorResponse(syncResult.code, syncResult.error, status);
  }

  return jsonResponse({
    success: true,
    collection: name,
    note: "Collection removed from config. Indexed documents remain in DB.",
  });
}

/**
 * POST /api/sync
 * Trigger re-index of all or specific collection.
 */
export async function handleSync(
  ctxHolder: ContextHolder,
  store: SqliteAdapter,
  req: Request
): Promise<Response> {
  let body: SyncRequestBody = {};
  try {
    const text = await req.text();
    if (text) {
      body = JSON.parse(text) as SyncRequestBody;
    }
  } catch {
    return errorResponse("VALIDATION", "Invalid JSON body");
  }

  // Validate optional fields
  if (body.collection !== undefined && typeof body.collection !== "string") {
    return errorResponse("VALIDATION", "collection must be a string");
  }
  if (body.gitPull !== undefined && typeof body.gitPull !== "boolean") {
    return errorResponse("VALIDATION", "gitPull must be a boolean");
  }

  // Get collections to sync (case-insensitive matching)
  const collectionName = body.collection?.toLowerCase();
  const collections = collectionName
    ? ctxHolder.config.collections.filter(
        (c) => c.name.toLowerCase() === collectionName
      )
    : ctxHolder.config.collections;

  if (body.collection && collections.length === 0) {
    return errorResponse(
      "NOT_FOUND",
      `Collection not found: ${body.collection}`,
      404
    );
  }

  if (collections.length === 0) {
    return errorResponse("VALIDATION", "No collections to sync");
  }

  // Start background sync job
  const jobResult = startJob("sync", async (): Promise<SyncResult> => {
    return await defaultSyncService.syncAll(collections, store, {
      gitPull: body.gitPull,
      runUpdateCmd: true,
    });
  });

  if (!jobResult.ok) {
    return errorResponse("CONFLICT", jobResult.error, 409);
  }

  return jsonResponse({ jobId: jobResult.jobId }, 202);
}

/**
 * GET /api/docs
 * Query params: collection, limit (default 20), offset (default 0), tagsAll, tagsAny
 * Returns paginated document list.
 */
export async function handleDocs(
  store: SqliteAdapter,
  url: URL
): Promise<Response> {
  const collection = url.searchParams.get("collection") || undefined;

  // Validate limit: positive integer, max 100
  const limitParam = Number(url.searchParams.get("limit"));
  if (
    url.searchParams.has("limit") &&
    (Number.isNaN(limitParam) || limitParam < 1)
  ) {
    return errorResponse("VALIDATION", "limit must be a positive integer");
  }
  const limit = Math.min(limitParam || 20, 100);

  // Validate offset: non-negative integer
  const offsetParam = Number(url.searchParams.get("offset"));
  if (
    url.searchParams.has("offset") &&
    (Number.isNaN(offsetParam) || offsetParam < 0)
  ) {
    return errorResponse("VALIDATION", "offset must be a non-negative integer");
  }
  const offset = offsetParam || 0;

  // Parse tag filters
  let tagsAll: string[] | undefined;
  let tagsAny: string[] | undefined;

  const tagsAllParam = url.searchParams.get("tagsAll");
  if (tagsAllParam) {
    try {
      tagsAll = parseAndValidateTagFilter(tagsAllParam);
    } catch (e) {
      return errorResponse(
        "VALIDATION",
        e instanceof Error ? e.message : "Invalid tagsAll"
      );
    }
  }

  const tagsAnyParam = url.searchParams.get("tagsAny");
  if (tagsAnyParam) {
    try {
      tagsAny = parseAndValidateTagFilter(tagsAnyParam);
    } catch (e) {
      return errorResponse(
        "VALIDATION",
        e instanceof Error ? e.message : "Invalid tagsAny"
      );
    }
  }

  const result = await store.listDocumentsPaginated({
    collection,
    limit,
    offset,
    tagsAll,
    tagsAny,
  });

  if (!result.ok) {
    return errorResponse("RUNTIME", result.error.message, 500);
  }

  const { documents, total } = result.value;

  return jsonResponse({
    documents: documents.map((doc) => ({
      docid: doc.docid,
      uri: doc.uri,
      title: doc.title,
      collection: doc.collection,
      relPath: doc.relPath,
      sourceExt: doc.sourceExt,
      sourceMime: doc.sourceMime,
      updatedAt: doc.updatedAt,
    })),
    total,
    limit,
    offset,
  });
}

/**
 * GET /api/doc
 * Query params: uri (required)
 * Returns single document with content.
 */
export async function handleDoc(
  store: SqliteAdapter,
  url: URL
): Promise<Response> {
  const uri = url.searchParams.get("uri");
  if (!uri) {
    return errorResponse("VALIDATION", "Missing uri parameter");
  }

  const docResult = await store.getDocumentByUri(uri);
  if (!docResult.ok) {
    return errorResponse("RUNTIME", docResult.error.message, 500);
  }
  if (!docResult.value) {
    return errorResponse("NOT_FOUND", "Document not found", 404);
  }

  const doc = docResult.value;
  let content: string | null = null;

  if (doc.mirrorHash) {
    const contentResult = await store.getContent(doc.mirrorHash);
    if (contentResult.ok && contentResult.value) {
      content = contentResult.value;
    }
  }

  // Get tags for this document
  let tags: string[] = [];
  const tagsResult = await store.getTagsForDoc(doc.id);
  if (tagsResult.ok) {
    tags = tagsResult.value.map((t) => t.tag);
  }

  return jsonResponse({
    docid: doc.docid,
    uri: doc.uri,
    title: doc.title,
    content,
    contentAvailable: content !== null,
    collection: doc.collection,
    relPath: doc.relPath,
    tags,
    source: {
      mime: doc.sourceMime,
      ext: doc.sourceExt,
      modifiedAt: doc.sourceMtime,
      sizeBytes: doc.sourceSize,
    },
  });
}

/**
 * GET /api/tags
 * Query params: collection, prefix
 * Returns tag list with document counts.
 */
export async function handleTags(
  store: SqliteAdapter,
  url: URL
): Promise<Response> {
  const collectionRaw = url.searchParams.get("collection") || undefined;
  const prefixRaw = url.searchParams.get("prefix") || undefined;

  // Normalize collection to lowercase if provided
  const collection = collectionRaw?.toLowerCase();

  // Validate and normalize prefix using tag grammar
  let prefix: string | undefined;
  if (prefixRaw) {
    const normalized = normalizeTag(prefixRaw);
    // Strip trailing slash for prefix queries (allows "project/" to find "project/*")
    const prefixToValidate = normalized.endsWith("/")
      ? normalized.slice(0, -1)
      : normalized;
    // Only validate if non-empty (empty prefix = list all)
    if (prefixToValidate.length > 0 && !validateTag(prefixToValidate)) {
      return errorResponse(
        "VALIDATION",
        `Invalid prefix: "${prefixRaw}". Must follow tag format.`
      );
    }
    // Use stripped version for query (store expects prefix without trailing slash)
    prefix = prefixToValidate || undefined;
  }

  const result = await store.getTagCounts({ collection, prefix });

  if (!result.ok) {
    return errorResponse("RUNTIME", result.error.message, 500);
  }

  const tags = result.value;

  return jsonResponse({
    tags,
    meta: {
      totalTags: tags.length,
      ...(collection && { collection }),
      ...(prefix && { prefix }),
    },
  });
}

/**
 * POST /api/docs/:id/deactivate
 * Deactivate a document (soft delete - does not remove file from disk).
 */
export async function handleDeactivateDoc(
  store: SqliteAdapter,
  docId: string
): Promise<Response> {
  // Get document to verify it exists and get collection/relPath
  const docResult = await store.getDocumentByDocid(docId);
  if (!docResult.ok) {
    return errorResponse("RUNTIME", docResult.error.message, 500);
  }
  if (!docResult.value) {
    return errorResponse("NOT_FOUND", "Document not found", 404);
  }

  const doc = docResult.value;

  // Mark as inactive
  const result = await store.markInactive(doc.collection, [doc.relPath]);
  if (!result.ok) {
    return errorResponse("RUNTIME", result.error.message, 500);
  }

  return jsonResponse({
    success: true,
    docId: doc.docid,
    path: doc.uri,
    warning: "File still exists on disk. Will be re-indexed unless excluded.",
  });
}

/**
 * PUT /api/docs/:id
 * Update an existing document's content and/or tags.
 */
export async function handleUpdateDoc(
  ctxHolder: ContextHolder,
  store: SqliteAdapter,
  docId: string,
  req: Request
): Promise<Response> {
  let body: UpdateDocRequestBody;
  try {
    body = (await req.json()) as UpdateDocRequestBody;
  } catch {
    return errorResponse("VALIDATION", "Invalid JSON body");
  }

  // At least one of content or tags must be provided
  const hasContent = body.content !== undefined;
  const hasTags = body.tags !== undefined;

  if (!hasContent && !hasTags) {
    return errorResponse("VALIDATION", "Must provide content or tags");
  }

  // Validate content if provided (allow empty string)
  if (hasContent && typeof body.content !== "string") {
    return errorResponse("VALIDATION", "content must be a string");
  }

  // Validate tags if provided
  let normalizedTags: string[] | undefined;
  if (hasTags) {
    if (!Array.isArray(body.tags)) {
      return errorResponse("VALIDATION", "tags must be an array");
    }
    normalizedTags = [];
    for (const tag of body.tags) {
      if (typeof tag !== "string") {
        return errorResponse("VALIDATION", "Each tag must be a string");
      }
      const normalized = normalizeTag(tag);
      if (!validateTag(normalized)) {
        return errorResponse(
          "VALIDATION",
          `Invalid tag: "${tag}". Tags must be lowercase, alphanumeric with hyphens/dots/slashes.`
        );
      }
      normalizedTags.push(normalized);
    }
  }

  // Get document to verify it exists
  const docResult = await store.getDocumentByDocid(docId);
  if (!docResult.ok) {
    return errorResponse("RUNTIME", docResult.error.message, 500);
  }
  if (!docResult.value) {
    return errorResponse("NOT_FOUND", "Document not found", 404);
  }

  const doc = docResult.value;

  // Find collection config (case-insensitive)
  const collectionName = doc.collection.toLowerCase();
  const collection = ctxHolder.config.collections.find(
    (c) => c.name.toLowerCase() === collectionName
  );
  if (!collection) {
    return errorResponse(
      "NOT_FOUND",
      `Collection not found: ${doc.collection}`,
      404
    );
  }

  // Validate and resolve full path
  // Critical: validate relPath from DB to prevent path traversal attacks
  const nodePath = await import("node:path"); // no bun equivalent
  let safeRelPath: string;
  try {
    safeRelPath = validateRelPath(doc.relPath);
  } catch {
    return errorResponse("VALIDATION", "Invalid document relPath in DB", 400);
  }
  const fullPath = nodePath.join(collection.path, safeRelPath);

  // Verify file exists
  const file = Bun.file(fullPath);
  if (!(await file.exists())) {
    return errorResponse("FILE_NOT_FOUND", "Source file no longer exists", 404);
  }

  // Determine if we can write tags back to file
  const isMarkdown =
    doc.sourceMime === "text/markdown" || doc.sourceExt === ".md";
  let writeBack: "applied" | "skipped_unsupported" | undefined;

  try {
    // Determine final content to write
    let contentToWrite: string | undefined;

    if (hasContent) {
      contentToWrite = body.content;
    }

    // Handle tag writeback for Markdown files
    if (hasTags && normalizedTags) {
      if (isMarkdown) {
        // Read current content if we're only updating tags
        const source = contentToWrite ?? (await file.text());
        contentToWrite = updateFrontmatterTags(source, normalizedTags);
        writeBack = "applied";
      } else {
        writeBack = "skipped_unsupported";
      }

      // Update tags in DB (user source since this is a user action)
      const tagResult = await store.setDocTags(doc.id, normalizedTags, "user");
      if (!tagResult.ok) {
        return errorResponse("RUNTIME", tagResult.error.message, 500);
      }
    }

    // Write file if we have content to write
    if (contentToWrite !== undefined) {
      await atomicWrite(fullPath, contentToWrite);
    }

    // Build proper file:// URI using node:url
    const { pathToFileURL } = await import("node:url");
    const fileUri = pathToFileURL(fullPath).href;

    // Run sync via job system (non-blocking) only if content changed
    let jobId: string | null = null;
    if (contentToWrite !== undefined) {
      const jobResult = startJob("sync", async (): Promise<SyncResult> => {
        const result = await defaultSyncService.syncCollection(
          collection,
          store,
          { runUpdateCmd: false }
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
      });
      jobId = jobResult.ok ? jobResult.jobId : null;
    }

    return jsonResponse({
      success: true,
      docId: doc.docid,
      uri: fileUri,
      path: fullPath,
      jobId,
      writeBack,
    });
  } catch (e) {
    return errorResponse(
      "RUNTIME",
      `Failed to update document: ${e instanceof Error ? e.message : String(e)}`,
      500
    );
  }
}

/**
 * POST /api/docs
 * Create a new document in a collection.
 * Returns 202 with jobId for async sync.
 */
export async function handleCreateDoc(
  ctxHolder: ContextHolder,
  store: SqliteAdapter,
  req: Request
): Promise<Response> {
  let body: CreateDocRequestBody;
  try {
    body = (await req.json()) as CreateDocRequestBody;
  } catch {
    return errorResponse("VALIDATION", "Invalid JSON body");
  }

  // Validate required fields with type checks
  if (!body.collection || typeof body.collection !== "string") {
    return errorResponse("VALIDATION", "Missing or invalid collection");
  }
  if (!body.relPath || typeof body.relPath !== "string") {
    return errorResponse("VALIDATION", "Missing or invalid relPath");
  }
  if (!body.content || typeof body.content !== "string") {
    return errorResponse("VALIDATION", "Missing or invalid content");
  }
  if (body.overwrite !== undefined && typeof body.overwrite !== "boolean") {
    return errorResponse("VALIDATION", "overwrite must be a boolean");
  }

  // Validate tags if provided
  let validatedTags: string[] = [];
  if (body.tags && Array.isArray(body.tags)) {
    try {
      validatedTags = parseAndValidateTagFilter(body.tags.join(","));
    } catch (e) {
      return errorResponse(
        "VALIDATION",
        e instanceof Error ? e.message : "Invalid tags"
      );
    }
  }

  // Find collection (case-insensitive)
  const collectionName = body.collection.toLowerCase();
  const collection = ctxHolder.config.collections.find(
    (c) => c.name.toLowerCase() === collectionName
  );
  if (!collection) {
    return errorResponse(
      "NOT_FOUND",
      `Collection not found: ${body.collection}`,
      404
    );
  }

  // Validate relPath - no path traversal
  let normalizedRelPath: string;
  try {
    normalizedRelPath = validateRelPath(body.relPath);
  } catch (e) {
    return errorResponse(
      "VALIDATION",
      e instanceof Error ? e.message : String(e)
    );
  }

  const nodePath = await import("node:path"); // no bun equivalent
  const fullPath = nodePath.join(collection.path, normalizedRelPath);

  try {
    // Check if file already exists
    const file = Bun.file(fullPath);
    if ((await file.exists()) && !body.overwrite) {
      return errorResponse(
        "CONFLICT",
        "File already exists. Set overwrite=true to replace.",
        409
      );
    }

    // Ensure parent directory exists
    const parentDir = nodePath.dirname(fullPath);
    const { mkdir } = await import("node:fs/promises"); // structure ops need fs
    await mkdir(parentDir, { recursive: true });

    // Inject tags into frontmatter for markdown files
    let contentToWrite = body.content;
    const ext = nodePath.extname(normalizedRelPath).toLowerCase();
    if (validatedTags.length > 0 && (ext === ".md" || ext === ".markdown")) {
      contentToWrite = updateFrontmatterTags(body.content, validatedTags);
    }

    await atomicWrite(fullPath, contentToWrite);

    // Build proper file:// URI using node:url
    const { pathToFileURL } = await import("node:url");
    const fileUri = pathToFileURL(fullPath).href;

    // Run sync via job system (non-blocking)
    const jobResult = startJob("sync", async (): Promise<SyncResult> => {
      const result = await defaultSyncService.syncCollection(
        collection,
        store,
        { runUpdateCmd: false }
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
    });

    return jsonResponse(
      {
        uri: fileUri,
        path: fullPath,
        jobId: jobResult.ok ? jobResult.jobId : null,
        note: jobResult.ok
          ? "File created. Sync job started - poll /api/jobs/:id for status."
          : "File created. Sync skipped (another job running).",
      },
      202
    );
  } catch (e) {
    return errorResponse(
      "RUNTIME",
      `Failed to create document: ${e instanceof Error ? e.message : String(e)}`,
      500
    );
  }
}

/**
 * POST /api/search
 * Body: { query, mode?, limit?, minScore?, collection? }
 * Returns search results.
 */
export async function handleSearch(
  store: SqliteAdapter,
  req: Request
): Promise<Response> {
  let body: SearchRequestBody;
  try {
    body = (await req.json()) as SearchRequestBody;
  } catch {
    return errorResponse("VALIDATION", "Invalid JSON body");
  }

  if (!body.query || typeof body.query !== "string") {
    return errorResponse("VALIDATION", "Missing or invalid query");
  }

  const query = body.query.trim();
  if (!query) {
    return errorResponse("VALIDATION", "Query cannot be empty");
  }

  // Validate limit: positive integer
  if (
    body.limit !== undefined &&
    (typeof body.limit !== "number" || body.limit < 1)
  ) {
    return errorResponse("VALIDATION", "limit must be a positive integer");
  }

  // Validate minScore: number between 0 and 1
  if (
    body.minScore !== undefined &&
    (typeof body.minScore !== "number" ||
      body.minScore < 0 ||
      body.minScore > 1)
  ) {
    return errorResponse(
      "VALIDATION",
      "minScore must be a number between 0 and 1"
    );
  }

  // Parse tag filters
  let tagsAll: string[] | undefined;
  let tagsAny: string[] | undefined;

  if (body.tagsAll) {
    try {
      tagsAll = parseAndValidateTagFilter(body.tagsAll);
    } catch (e) {
      return errorResponse(
        "VALIDATION",
        e instanceof Error ? e.message : "Invalid tagsAll"
      );
    }
  }

  if (body.tagsAny) {
    try {
      tagsAny = parseAndValidateTagFilter(body.tagsAny);
    } catch (e) {
      return errorResponse(
        "VALIDATION",
        e instanceof Error ? e.message : "Invalid tagsAny"
      );
    }
  }

  // Only BM25 supported in web UI (vector/hybrid require LLM ports)
  const options: SearchOptions = {
    limit: Math.min(body.limit || 10, 50),
    minScore: body.minScore,
    collection: body.collection,
    tagsAll,
    tagsAny,
  };

  const result = await searchBm25(store, query, options);

  if (!result.ok) {
    return errorResponse("RUNTIME", result.error.message, 500);
  }

  return jsonResponse(result.value);
}

/**
 * POST /api/query
 * Body: { query, limit?, minScore?, collection?, lang?, noExpand?, noRerank? }
 * Returns hybrid search results (BM25 + vector + expansion + reranking).
 */
export async function handleQuery(
  ctx: ServerContext,
  req: Request
): Promise<Response> {
  let body: QueryRequestBody;
  try {
    body = (await req.json()) as QueryRequestBody;
  } catch {
    return errorResponse("VALIDATION", "Invalid JSON body");
  }

  if (!body.query || typeof body.query !== "string") {
    return errorResponse("VALIDATION", "Missing or invalid query");
  }

  const query = body.query.trim();
  if (!query) {
    return errorResponse("VALIDATION", "Query cannot be empty");
  }

  // Validate limit
  if (
    body.limit !== undefined &&
    (typeof body.limit !== "number" || body.limit < 1)
  ) {
    return errorResponse("VALIDATION", "limit must be a positive integer");
  }

  // Validate minScore
  if (
    body.minScore !== undefined &&
    (typeof body.minScore !== "number" ||
      body.minScore < 0 ||
      body.minScore > 1)
  ) {
    return errorResponse(
      "VALIDATION",
      "minScore must be a number between 0 and 1"
    );
  }

  // Parse tag filters
  let tagsAll: string[] | undefined;
  let tagsAny: string[] | undefined;

  if (body.tagsAll) {
    try {
      tagsAll = parseAndValidateTagFilter(body.tagsAll);
    } catch (e) {
      return errorResponse(
        "VALIDATION",
        e instanceof Error ? e.message : "Invalid tagsAll"
      );
    }
  }

  if (body.tagsAny) {
    try {
      tagsAny = parseAndValidateTagFilter(body.tagsAny);
    } catch (e) {
      return errorResponse(
        "VALIDATION",
        e instanceof Error ? e.message : "Invalid tagsAny"
      );
    }
  }

  const result = await searchHybrid(
    {
      store: ctx.store,
      config: ctx.config,
      vectorIndex: ctx.vectorIndex,
      embedPort: ctx.embedPort,
      genPort: ctx.genPort,
      rerankPort: ctx.rerankPort,
    },
    query,
    {
      limit: Math.min(body.limit ?? 20, 50),
      minScore: body.minScore,
      collection: body.collection,
      lang: body.lang,
      noExpand: body.noExpand,
      noRerank: body.noRerank,
      tagsAll,
      tagsAny,
    }
  );

  if (!result.ok) {
    return errorResponse("RUNTIME", result.error.message, 500);
  }

  return jsonResponse(result.value);
}

/**
 * POST /api/ask
 * Body: { query, limit?, collection?, lang?, maxAnswerTokens? }
 * Returns AI-generated answer with citations and sources.
 */
export async function handleAsk(
  ctx: ServerContext,
  req: Request
): Promise<Response> {
  let body: AskRequestBody;
  try {
    body = (await req.json()) as AskRequestBody;
  } catch {
    return errorResponse("VALIDATION", "Invalid JSON body");
  }

  if (!body.query || typeof body.query !== "string") {
    return errorResponse("VALIDATION", "Missing or invalid query");
  }

  const query = body.query.trim();
  if (!query) {
    return errorResponse("VALIDATION", "Query cannot be empty");
  }

  // Check if answer generation is available
  if (!ctx.capabilities.answer) {
    return errorResponse(
      "UNAVAILABLE",
      "Answer generation not available. No generation model loaded.",
      503
    );
  }

  // Parse tag filters
  let tagsAll: string[] | undefined;
  let tagsAny: string[] | undefined;

  if (body.tagsAll) {
    try {
      tagsAll = parseAndValidateTagFilter(body.tagsAll);
    } catch (e) {
      return errorResponse(
        "VALIDATION",
        e instanceof Error ? e.message : "Invalid tagsAll"
      );
    }
  }

  if (body.tagsAny) {
    try {
      tagsAny = parseAndValidateTagFilter(body.tagsAny);
    } catch (e) {
      return errorResponse(
        "VALIDATION",
        e instanceof Error ? e.message : "Invalid tagsAny"
      );
    }
  }

  const limit = Math.min(body.limit ?? 5, 20);

  // Run hybrid search first
  const searchResult = await searchHybrid(
    {
      store: ctx.store,
      config: ctx.config,
      vectorIndex: ctx.vectorIndex,
      embedPort: ctx.embedPort,
      genPort: ctx.genPort,
      rerankPort: ctx.rerankPort,
    },
    query,
    {
      limit,
      collection: body.collection,
      lang: body.lang,
      noExpand: body.noExpand,
      noRerank: body.noRerank,
      tagsAll,
      tagsAny,
    }
  );

  if (!searchResult.ok) {
    return errorResponse("RUNTIME", searchResult.error.message, 500);
  }

  const results = searchResult.value.results;

  // Generate grounded answer (requires genPort)
  let answer: string | undefined;
  let citations: Citation[] | undefined;
  let answerGenerated = false;

  if (ctx.genPort) {
    const maxTokens = body.maxAnswerTokens ?? 512;
    const rawResult = await generateGroundedAnswer(
      { genPort: ctx.genPort, store: ctx.store },
      query,
      results,
      maxTokens
    );

    if (rawResult) {
      const processed = processAnswerResult(rawResult);
      answer = processed.answer;
      citations = processed.citations;
      answerGenerated = true;
    }
  }

  const askResult: AskResult = {
    query,
    mode: searchResult.value.meta.vectorsUsed ? "hybrid" : "bm25_only",
    queryLanguage: searchResult.value.meta.queryLanguage ?? "und",
    answer,
    citations,
    results,
    meta: {
      expanded: searchResult.value.meta.expanded ?? false,
      reranked: searchResult.value.meta.reranked ?? false,
      vectorsUsed: searchResult.value.meta.vectorsUsed ?? false,
      answerGenerated,
      totalResults: results.length,
    },
  };

  return jsonResponse(askResult);
}

// ─────────────────────────────────────────────────────────────────────────────
// Status with capabilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/capabilities
 * Returns server capabilities (what features are available).
 */
export function handleCapabilities(ctx: ServerContext): Response {
  return jsonResponse({
    bm25: ctx.capabilities.bm25,
    vector: ctx.capabilities.vector,
    hybrid: ctx.capabilities.hybrid,
    answer: ctx.capabilities.answer,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Presets
// ─────────────────────────────────────────────────────────────────────────────

export interface PresetInfo extends ModelPreset {
  active: boolean;
}

/**
 * GET /api/presets
 * Returns available model presets and which is active.
 */
export function handlePresets(ctx: ServerContext): Response {
  const modelConfig = getModelConfig(ctx.config);
  const presets = listPresets(ctx.config);
  const activeId = modelConfig.activePreset;

  const presetsWithStatus: PresetInfo[] = presets.map((p) => ({
    ...p,
    active: p.id === activeId,
  }));

  return jsonResponse({
    presets: presetsWithStatus,
    activePreset: activeId,
    capabilities: ctx.capabilities,
  });
}

export interface SetPresetRequestBody {
  presetId: string;
}

/**
 * POST /api/presets
 * Switch to a different preset and reload LLM context.
 */
export async function handleSetPreset(
  ctxHolder: ContextHolder,
  req: Request
): Promise<Response> {
  let body: SetPresetRequestBody;
  try {
    body = (await req.json()) as SetPresetRequestBody;
  } catch {
    return errorResponse("VALIDATION", "Invalid JSON body");
  }

  if (!body.presetId || typeof body.presetId !== "string") {
    return errorResponse("VALIDATION", "Missing or invalid presetId");
  }

  // Validate preset exists
  const preset = getPreset(ctxHolder.config, body.presetId);
  if (!preset) {
    return errorResponse("NOT_FOUND", `Unknown preset: ${body.presetId}`, 404);
  }

  // Update config with new active preset (use getModelConfig to get defaults)
  const currentModelConfig = getModelConfig(ctxHolder.config);
  const newConfig: Config = {
    ...ctxHolder.config,
    models: {
      ...currentModelConfig,
      activePreset: body.presetId,
    },
  };

  console.log(`Switching to preset: ${preset.name}`);

  // Reload context with new config
  try {
    ctxHolder.current = await reloadServerContext(ctxHolder.current, newConfig);
    ctxHolder.config = newConfig;
  } catch (e) {
    return errorResponse(
      "RUNTIME",
      `Failed to reload context: ${e instanceof Error ? e.message : String(e)}`,
      500
    );
  }

  return jsonResponse({
    success: true,
    activePreset: body.presetId,
    capabilities: ctxHolder.current.capabilities,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Model Download
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/models/status
 * Returns current download status for polling.
 */
export function handleModelStatus(): Response {
  return jsonResponse({
    active: downloadState.active,
    currentType: downloadState.currentType,
    progress: downloadState.progress,
    completed: downloadState.completed,
    failed: downloadState.failed,
    startedAt: downloadState.startedAt,
  });
}

/**
 * POST /api/models/pull
 * Start downloading models for current preset.
 * Returns immediately; poll /api/models/status for progress.
 */
export function handleModelPull(ctxHolder: ContextHolder): Response {
  // Don't start if already downloading
  if (downloadState.active) {
    return errorResponse("CONFLICT", "Download already in progress", 409);
  }

  // Reset and start
  resetDownloadState();
  downloadState.active = true;
  downloadState.startedAt = Date.now();

  // Run download in background (don't await)
  // Pass current config so it uses the active preset from UI
  modelsPull({
    config: ctxHolder.config,
    all: true,
    onProgress: (type, progress) => {
      downloadState.currentType = type;
      downloadState.progress = progress;
    },
  })
    .then(async (result) => {
      // Track results
      for (const r of result.results) {
        if (r.ok) {
          if (!r.skipped) {
            downloadState.completed.push(r.type);
          }
        } else {
          downloadState.failed.push({
            type: r.type,
            error: r.error ?? "Unknown error",
          });
        }
      }

      // Reload context to pick up new models
      console.log("Models downloaded, reloading context...");
      try {
        ctxHolder.current = await reloadServerContext(
          ctxHolder.current,
          ctxHolder.config
        );
        console.log("Context reloaded");
      } catch (e) {
        console.error("Failed to reload context:", e);
      }

      downloadState.active = false;
      downloadState.currentType = null;
      downloadState.progress = null;
    })
    .catch((e) => {
      console.error("Model download failed:", e);
      downloadState.active = false;
      downloadState.failed.push({
        type: downloadState.currentType ?? "embed",
        error: e instanceof Error ? e.message : String(e),
      });
    });

  return jsonResponse({
    started: true,
    message: "Download started. Poll /api/models/status for progress.",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Jobs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/jobs/:id
 * Poll job status for async operations.
 */
export function handleJob(jobId: string): Response {
  const status = getJobStatus(jobId);
  if (!status) {
    return errorResponse("NOT_FOUND", "Job not found or expired", 404);
  }
  return jsonResponse(status);
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Route an API request to the appropriate handler.
 * Returns null if the path is not an API route.
 * Note: Currently unused since we use routes object in Bun.serve().
 */
// oxlint-disable-next-line typescript-eslint/require-await -- handlers are async, kept for future use
export async function routeApi(
  store: SqliteAdapter,
  req: Request,
  url: URL
): Promise<Response | null> {
  const path = url.pathname;

  // CSRF protection: validate Origin for non-GET requests
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.get("origin");
    const secFetchSite = req.headers.get("sec-fetch-site");

    // Reject cross-origin requests (allow same-origin or no origin for curl)
    if (origin) {
      const originUrl = new URL(origin);
      if (
        originUrl.hostname !== "127.0.0.1" &&
        originUrl.hostname !== "localhost"
      ) {
        return errorResponse(
          "FORBIDDEN",
          "Cross-origin requests not allowed",
          403
        );
      }
    } else if (
      secFetchSite &&
      secFetchSite !== "same-origin" &&
      secFetchSite !== "none"
    ) {
      return errorResponse(
        "FORBIDDEN",
        "Cross-origin requests not allowed",
        403
      );
    }
  }

  if (path === "/api/health") {
    return handleHealth();
  }

  if (path === "/api/status") {
    return handleStatus(store);
  }

  if (path === "/api/collections") {
    return handleCollections(store);
  }

  if (path === "/api/docs") {
    return handleDocs(store, url);
  }

  if (path === "/api/doc") {
    return handleDoc(store, url);
  }

  if (path === "/api/search" && req.method === "POST") {
    return handleSearch(store, req);
  }

  // Unknown API route
  if (path.startsWith("/api/")) {
    return errorResponse("NOT_FOUND", `Unknown API endpoint: ${path}`, 404);
  }

  return null;
}
