/**
 * REST API routes for GNO web UI.
 * All routes return JSON with consistent error format.
 *
 * @module src/serve/routes/api
 */

import type { Config, ModelPreset } from "../../config/types";
import type {
  AskResult,
  Citation,
  QueryModeInput,
  SearchOptions,
} from "../../pipeline/types";
import type { SqliteAdapter } from "../../store/sqlite/adapter";
import type { DocumentEventBus } from "../doc-events";
import type { EmbedScheduler } from "../embed-scheduler";
import type { CollectionWatchService } from "../watch-service";

import { modelsPull } from "../../cli/commands/models/pull";
import { addCollection, removeCollection } from "../../collection";
import {
  buildEditableCopyContent,
  deriveEditableCopyRelPath,
  getDocumentCapabilities,
} from "../../core/document-capabilities";
import { atomicWrite } from "../../core/file-ops";
import { normalizeStructuredQueryInput } from "../../core/structured-query";
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
import { validateQueryModes } from "../../pipeline/query-modes";
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
  scheduler: EmbedScheduler | null;
  eventBus: DocumentEventBus | null;
  watchService: CollectionWatchService | null;
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
  intent?: string;
  exclude?: string;
  since?: string;
  until?: string;
  /** Comma-separated category filters */
  category?: string;
  author?: string;
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
  intent?: string;
  candidateLimit?: number;
  exclude?: string;
  since?: string;
  until?: string;
  /** Comma-separated category filters */
  category?: string;
  author?: string;
  queryModes?: QueryModeInput[];
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
  intent?: string;
  candidateLimit?: number;
  exclude?: string;
  queryModes?: QueryModeInput[];
  since?: string;
  until?: string;
  /** Comma-separated category filters */
  category?: string;
  author?: string;
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
  /** Expected source hash for optimistic concurrency */
  expectedSourceHash?: string;
  /** Expected source modified timestamp for optimistic concurrency */
  expectedModifiedAt?: string;
}

export interface CreateEditableCopyRequestBody {
  collection?: string;
  relPath?: string;
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

function parseCommaSeparatedValues(input: string): string[] {
  return Array.from(
    new Set(
      input
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
    )
  );
}

function hashContent(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

interface SourceMeta {
  absPath?: string;
  mime: string;
  ext: string;
  modifiedAt?: string;
  sizeBytes?: number;
  sourceHash?: string;
}

function getCollectionByName(
  collections: Config["collections"],
  collectionName: string
) {
  return collections.find(
    (c) => c.name.toLowerCase() === collectionName.toLowerCase()
  );
}

async function resolveAbsoluteDocPath(
  collections: Config["collections"],
  doc: { collection: string; relPath: string }
): Promise<{
  collection: Config["collections"][number];
  fullPath: string;
} | null> {
  const collection = getCollectionByName(collections, doc.collection);
  if (!collection) {
    return null;
  }

  const nodePath = await import("node:path"); // no bun equivalent
  let safeRelPath: string;
  try {
    safeRelPath = validateRelPath(doc.relPath);
  } catch {
    return null;
  }
  return {
    collection,
    fullPath: nodePath.join(collection.path, safeRelPath),
  };
}

async function buildSourceMeta(
  collections: Config["collections"],
  doc: {
    collection: string;
    relPath: string;
    sourceMime: string;
    sourceExt: string;
    sourceMtime?: string | null;
    sourceSize?: number;
    sourceHash?: string;
  }
): Promise<SourceMeta> {
  const resolved = await resolveAbsoluteDocPath(collections, doc);
  return {
    absPath: resolved?.fullPath,
    mime: doc.sourceMime,
    ext: doc.sourceExt,
    modifiedAt: doc.sourceMtime ?? undefined,
    sizeBytes: doc.sourceSize,
    sourceHash: doc.sourceHash,
  };
}

function parseQueryModesInput(value: unknown): {
  queryModes?: QueryModeInput[];
  error?: Response;
} {
  if (value === undefined) {
    return {};
  }

  if (!Array.isArray(value)) {
    return {
      error: errorResponse(
        "VALIDATION",
        "queryModes must be an array of { mode, text } objects"
      ),
    };
  }

  const queryModes: QueryModeInput[] = [];
  let hydeCount = 0;

  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== "object") {
      return {
        error: errorResponse(
          "VALIDATION",
          `queryModes[${index}] must be an object`
        ),
      };
    }

    const mode = (entry as { mode?: unknown }).mode;
    const text = (entry as { text?: unknown }).text;
    if (mode !== "term" && mode !== "intent" && mode !== "hyde") {
      return {
        error: errorResponse(
          "VALIDATION",
          `queryModes[${index}].mode must be one of: term, intent, hyde`
        ),
      };
    }
    if (typeof text !== "string" || !text.trim()) {
      return {
        error: errorResponse(
          "VALIDATION",
          `queryModes[${index}].text must be a non-empty string`
        ),
      };
    }

    if (mode === "hyde") {
      hydeCount += 1;
      if (hydeCount > 1) {
        return {
          error: errorResponse(
            "VALIDATION",
            "Only one hyde mode is allowed in queryModes"
          ),
        };
      }
    }

    queryModes.push({ mode, text: text.trim() });
  }

  const validated = validateQueryModes(queryModes);
  if (!validated.ok) {
    return {
      error: errorResponse("VALIDATION", validated.error.message),
    };
  }

  return { queryModes: validated.value };
}

function normalizeStructuredQueryBody(
  query: string,
  queryModes: QueryModeInput[] | undefined
): {
  query?: string;
  queryModes?: QueryModeInput[];
  error?: Response;
} {
  const normalized = normalizeStructuredQueryInput(query, queryModes ?? []);
  if (!normalized.ok) {
    return {
      error: errorResponse("VALIDATION", normalized.error.message),
    };
  }

  return {
    query: normalized.value.query,
    queryModes:
      normalized.value.queryModes.length > 0
        ? normalized.value.queryModes
        : undefined,
  };
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
    // Notify scheduler after sync completes (triggers debounced embed)
    if (result.filesAdded > 0 || result.filesUpdated > 0) {
      ctxHolder.scheduler?.notifySyncComplete(["add-batch"]);
    }
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
    const result = await defaultSyncService.syncAll(collections, store, {
      gitPull: body.gitPull,
      runUpdateCmd: true,
    });
    // Notify scheduler after sync completes (triggers debounced embed)
    if (result.totalFilesAdded > 0 || result.totalFilesUpdated > 0) {
      ctxHolder.scheduler?.notifySyncComplete(["sync-batch"]);
    }
    return result;
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
  const sortFieldRaw = (url.searchParams.get("sortField") ?? "modified")
    .trim()
    .toLowerCase();
  const sortOrderRaw = (url.searchParams.get("sortOrder") ?? "desc")
    .trim()
    .toLowerCase();

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

  if (sortFieldRaw !== "modified" && !/^[a-z0-9_]+$/.test(sortFieldRaw)) {
    return errorResponse(
      "VALIDATION",
      "sortField must be 'modified' or a lowercase frontmatter date key"
    );
  }

  if (sortOrderRaw !== "asc" && sortOrderRaw !== "desc") {
    return errorResponse("VALIDATION", "sortOrder must be 'asc' or 'desc'");
  }
  const sortOrder: "asc" | "desc" = sortOrderRaw === "asc" ? "asc" : "desc";

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

  const dateFieldsResult = await store.getCollectionDateFields(collection);
  if (!dateFieldsResult.ok) {
    return errorResponse("RUNTIME", dateFieldsResult.error.message, 500);
  }
  const availableDateFields = dateFieldsResult.value;

  if (
    sortFieldRaw !== "modified" &&
    !availableDateFields.includes(sortFieldRaw)
  ) {
    return errorResponse(
      "VALIDATION",
      `Unknown sortField: ${sortFieldRaw} for current collection`
    );
  }

  const result = await store.listDocumentsPaginated({
    collection,
    limit,
    offset,
    tagsAll,
    tagsAny,
    sortField: sortFieldRaw,
    sortOrder,
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
    availableDateFields,
    sortField: sortFieldRaw,
    sortOrder,
  });
}

/**
 * GET /api/docs/autocomplete
 * Query params: query, collection, limit
 */
export async function handleDocsAutocomplete(
  store: SqliteAdapter,
  url: URL
): Promise<Response> {
  const query = (url.searchParams.get("query") ?? "").trim().toLowerCase();
  const collection = url.searchParams.get("collection") || undefined;
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "8") || 8, 20);

  const result = await store.listDocuments(collection);
  if (!result.ok) {
    return errorResponse("RUNTIME", result.error.message, 500);
  }

  const candidates = result.value
    .filter((doc) => doc.active)
    .map((doc) => ({
      docid: doc.docid,
      uri: doc.uri,
      title:
        doc.title ??
        doc.relPath
          .split("/")
          .pop()
          ?.replace(/\.[^.]+$/, "") ??
        doc.relPath,
      collection: doc.collection,
    }))
    .filter((doc) => {
      if (!query) return true;
      const haystack = `${doc.title} ${doc.uri}`.toLowerCase();
      return haystack.includes(query);
    })
    .sort((a, b) => a.title.localeCompare(b.title))
    .slice(0, limit);

  return jsonResponse({ docs: candidates });
}

/**
 * GET /api/doc
 * Query params: uri (required)
 * Returns single document with content.
 */
export async function handleDoc(
  store: SqliteAdapter,
  config: Config,
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

  const contentAvailable = content !== null;
  const capabilities = getDocumentCapabilities({
    sourceExt: doc.sourceExt,
    sourceMime: doc.sourceMime,
    contentAvailable,
  });
  const source = await buildSourceMeta(config.collections, doc);

  return jsonResponse({
    docid: doc.docid,
    uri: doc.uri,
    title: doc.title,
    content,
    contentAvailable,
    collection: doc.collection,
    relPath: doc.relPath,
    tags,
    source,
    capabilities,
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
  if (
    body.expectedSourceHash !== undefined &&
    typeof body.expectedSourceHash !== "string"
  ) {
    return errorResponse("VALIDATION", "expectedSourceHash must be a string");
  }
  if (
    body.expectedModifiedAt !== undefined &&
    typeof body.expectedModifiedAt !== "string"
  ) {
    return errorResponse("VALIDATION", "expectedModifiedAt must be a string");
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

  const resolvedDocPath = await resolveAbsoluteDocPath(
    ctxHolder.config.collections,
    doc
  );
  if (!resolvedDocPath) {
    return errorResponse(
      "NOT_FOUND",
      `Collection not found: ${doc.collection}`,
      404
    );
  }
  const { collection, fullPath } = resolvedDocPath;

  // Verify file exists
  const file = Bun.file(fullPath);
  if (!(await file.exists())) {
    return errorResponse("FILE_NOT_FOUND", "Source file no longer exists", 404);
  }

  if (body.expectedSourceHash || body.expectedModifiedAt) {
    const currentBytes = await file.bytes();
    const currentSourceHash = hashContent(
      new TextDecoder().decode(currentBytes)
    );
    const { stat } = await import("node:fs/promises"); // no Bun structure stat parity
    const currentModifiedAt = (await stat(fullPath)).mtime.toISOString();

    if (
      (body.expectedSourceHash &&
        body.expectedSourceHash !== currentSourceHash) ||
      (body.expectedModifiedAt && body.expectedModifiedAt !== currentModifiedAt)
    ) {
      return jsonResponse(
        {
          error: {
            code: "CONFLICT",
            message: "Document changed on disk. Reload before saving.",
          },
          currentVersion: {
            sourceHash: currentSourceHash,
            modifiedAt: currentModifiedAt,
          },
        },
        409
      );
    }
  }

  const capabilities = getDocumentCapabilities({
    sourceExt: doc.sourceExt,
    sourceMime: doc.sourceMime,
    contentAvailable: doc.mirrorHash !== null,
  });
  if (hasContent && !capabilities.editable) {
    return errorResponse(
      "READ_ONLY",
      capabilities.reason ??
        "This document cannot be edited in place. Create an editable markdown copy instead.",
      409
    );
  }

  let writeBack: "applied" | "skipped_unsupported" | undefined;

  try {
    // Determine final content to write
    let contentToWrite: string | undefined;

    if (hasContent) {
      contentToWrite = body.content;
    }

    // Handle tag writeback for Markdown files
    if (hasTags && normalizedTags) {
      if (capabilities.tagsWriteback) {
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

    let currentSourceHash = doc.sourceHash;
    let currentModifiedAt = doc.sourceMtime;

    // Write file if we have content to write
    if (contentToWrite !== undefined) {
      ctxHolder.watchService?.suppress(fullPath);
      await atomicWrite(fullPath, contentToWrite);
      currentSourceHash = hashContent(contentToWrite);
      const { stat } = await import("node:fs/promises"); // no Bun structure stat parity
      currentModifiedAt = (await stat(fullPath)).mtime.toISOString();
    }

    // Build proper file:// URI using node:url
    const { pathToFileURL } = await import("node:url");
    const fileUri = pathToFileURL(fullPath).href;

    // Run sync via job system (non-blocking) only if content changed
    // Note: embedding handled separately by embed-scheduler (not inline)
    let jobId: string | null = null;
    if (contentToWrite !== undefined) {
      const jobResult = startJob("sync", async (): Promise<SyncResult> => {
        const result = await defaultSyncService.syncCollection(
          collection,
          store,
          { runUpdateCmd: false }
        );
        // Notify scheduler after sync completes
        ctxHolder.scheduler?.notifySyncComplete([doc.docid]);
        ctxHolder.eventBus?.emit({
          type: "document-changed",
          uri: doc.uri,
          collection: doc.collection,
          relPath: doc.relPath,
          origin: "save",
          changedAt: new Date().toISOString(),
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
      jobId = jobResult.ok ? jobResult.jobId : null;
    }

    return jsonResponse({
      success: true,
      docId: doc.docid,
      uri: fileUri,
      path: fullPath,
      jobId,
      writeBack,
      version: {
        sourceHash: currentSourceHash,
        modifiedAt: currentModifiedAt,
      },
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
 * POST /api/docs/:id/editable-copy
 * Create a markdown copy for a read-only/converted document.
 */
export async function handleCreateEditableCopy(
  ctxHolder: ContextHolder,
  store: SqliteAdapter,
  docId: string,
  req: Request
): Promise<Response> {
  let body: CreateEditableCopyRequestBody = {};
  try {
    const text = await req.text();
    if (text) {
      body = JSON.parse(text) as CreateEditableCopyRequestBody;
    }
  } catch {
    return errorResponse("VALIDATION", "Invalid JSON body");
  }

  if (body.collection !== undefined && typeof body.collection !== "string") {
    return errorResponse("VALIDATION", "collection must be a string");
  }
  if (body.relPath !== undefined && typeof body.relPath !== "string") {
    return errorResponse("VALIDATION", "relPath must be a string");
  }

  const docResult = await store.getDocumentByDocid(docId);
  if (!docResult.ok) {
    return errorResponse("RUNTIME", docResult.error.message, 500);
  }
  if (!docResult.value) {
    return errorResponse("NOT_FOUND", "Document not found", 404);
  }

  const doc = docResult.value;
  const contentAvailable = doc.mirrorHash !== null;
  const capabilities = getDocumentCapabilities({
    sourceExt: doc.sourceExt,
    sourceMime: doc.sourceMime,
    contentAvailable,
  });
  if (capabilities.editable) {
    return errorResponse(
      "VALIDATION",
      "Document is already editable in place; use the normal update route instead."
    );
  }
  if (!doc.mirrorHash) {
    return errorResponse(
      "RUNTIME",
      "Editable copy unavailable because converted content is missing.",
      409
    );
  }

  const contentResult = await store.getContent(doc.mirrorHash);
  if (!contentResult.ok || contentResult.value === null) {
    return errorResponse(
      "RUNTIME",
      "Editable copy unavailable because converted content is missing.",
      409
    );
  }

  const tagsResult = await store.getTagsForDoc(doc.id);
  const tags = tagsResult.ok ? tagsResult.value.map((tag) => tag.tag) : [];

  const targetCollectionName = body.collection ?? doc.collection;
  const targetCollection = getCollectionByName(
    ctxHolder.config.collections,
    targetCollectionName
  );
  if (!targetCollection) {
    return errorResponse(
      "NOT_FOUND",
      `Collection not found: ${targetCollectionName}`,
      404
    );
  }

  let relPath = body.relPath;
  if (!relPath) {
    const listResult = await store.listDocuments(targetCollection.name);
    const existingRelPaths = listResult.ok
      ? listResult.value.map((entry) => entry.relPath)
      : [];
    relPath = deriveEditableCopyRelPath(doc.relPath, existingRelPaths);
  }

  const title =
    doc.title ??
    doc.relPath
      .split("/")
      .pop()
      ?.replace(/\.[^.]+$/, "") ??
    "Copy";
  const content = buildEditableCopyContent({
    title,
    sourceDocid: doc.docid,
    sourceUri: doc.uri,
    sourceMime: doc.sourceMime,
    sourceExt: doc.sourceExt,
    content: contentResult.value,
    tags,
  });

  const createReq = new Request("http://localhost/api/docs", {
    method: "POST",
    body: JSON.stringify({
      collection: targetCollection.name,
      relPath,
      content,
      tags,
    } satisfies CreateDocRequestBody),
  });

  return handleCreateDoc(ctxHolder, store, createReq);
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

    ctxHolder.watchService?.suppress(fullPath);
    await atomicWrite(fullPath, contentToWrite);

    // Build gno:// URI for the created document
    const posixRelPath = normalizedRelPath.split(nodePath.sep).join("/");
    const gnoUri = `gno://${collection.name}/${posixRelPath}`;

    // Run sync via job system (non-blocking)
    // Note: embedding handled separately by embed-scheduler (not inline)
    const jobResult = startJob("sync", async (): Promise<SyncResult> => {
      const result = await defaultSyncService.syncCollection(
        collection,
        store,
        { runUpdateCmd: false }
      );
      // Notify scheduler after sync completes (use gnoUri as docid placeholder)
      // The sync will create a proper docid, but we don't have it here yet
      // Using normalizedRelPath as identifier since docid is generated during sync
      ctxHolder.scheduler?.notifySyncComplete([normalizedRelPath]);
      ctxHolder.eventBus?.emit({
        type: "document-changed",
        uri: gnoUri,
        collection: collection.name,
        relPath: normalizedRelPath,
        origin: "create",
        changedAt: new Date().toISOString(),
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

    return jsonResponse(
      {
        uri: gnoUri,
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

  const rawQuery = body.query.trim();
  if (!rawQuery) {
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

  if (body.since !== undefined && typeof body.since !== "string") {
    return errorResponse("VALIDATION", "since must be a string");
  }
  if (body.until !== undefined && typeof body.until !== "string") {
    return errorResponse("VALIDATION", "until must be a string");
  }
  if (body.intent !== undefined && typeof body.intent !== "string") {
    return errorResponse("VALIDATION", "intent must be a string");
  }
  if (body.exclude !== undefined && typeof body.exclude !== "string") {
    return errorResponse(
      "VALIDATION",
      "exclude must be a comma-separated string"
    );
  }
  if (body.category !== undefined && typeof body.category !== "string") {
    return errorResponse(
      "VALIDATION",
      "category must be a comma-separated string"
    );
  }
  if (body.author !== undefined && typeof body.author !== "string") {
    return errorResponse("VALIDATION", "author must be a string");
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

  const categories = body.category
    ? parseCommaSeparatedValues(body.category)
    : undefined;
  const exclude = body.exclude
    ? parseCommaSeparatedValues(body.exclude)
    : undefined;
  const author = body.author?.trim() || undefined;

  // Only BM25 supported in web UI (vector/hybrid require LLM ports)
  const options: SearchOptions = {
    limit: Math.min(body.limit || 10, 50),
    minScore: body.minScore,
    collection: body.collection,
    intent: body.intent?.trim() || undefined,
    exclude,
    tagsAll,
    tagsAny,
    since: body.since,
    until: body.until,
    categories,
    author,
  };

  const result = await searchBm25(store, rawQuery, options);

  if (!result.ok) {
    return errorResponse("RUNTIME", result.error.message, 500);
  }

  return jsonResponse(result.value);
}

/**
 * POST /api/query
 * Body: { query, limit?, minScore?, collection?, lang?, queryModes?, noExpand?, noRerank? }
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

  const rawQuery = body.query.trim();
  if (!rawQuery) {
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

  if (body.since !== undefined && typeof body.since !== "string") {
    return errorResponse("VALIDATION", "since must be a string");
  }
  if (body.until !== undefined && typeof body.until !== "string") {
    return errorResponse("VALIDATION", "until must be a string");
  }
  if (body.intent !== undefined && typeof body.intent !== "string") {
    return errorResponse("VALIDATION", "intent must be a string");
  }
  if (body.exclude !== undefined && typeof body.exclude !== "string") {
    return errorResponse(
      "VALIDATION",
      "exclude must be a comma-separated string"
    );
  }
  if (
    body.candidateLimit !== undefined &&
    (typeof body.candidateLimit !== "number" || body.candidateLimit < 1)
  ) {
    return errorResponse(
      "VALIDATION",
      "candidateLimit must be a positive integer"
    );
  }
  if (body.category !== undefined && typeof body.category !== "string") {
    return errorResponse(
      "VALIDATION",
      "category must be a comma-separated string"
    );
  }
  if (body.author !== undefined && typeof body.author !== "string") {
    return errorResponse("VALIDATION", "author must be a string");
  }

  const { queryModes, error: queryModesError } = parseQueryModesInput(
    body.queryModes
  );
  if (queryModesError) {
    return queryModesError;
  }

  const {
    query,
    queryModes: normalizedQueryModes,
    error: structuredQueryError,
  } = normalizeStructuredQueryBody(rawQuery, queryModes);
  if (structuredQueryError) {
    return structuredQueryError;
  }
  const normalizedQuery = query ?? rawQuery;

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

  const categories = body.category
    ? parseCommaSeparatedValues(body.category)
    : undefined;
  const exclude = body.exclude
    ? parseCommaSeparatedValues(body.exclude)
    : undefined;
  const author = body.author?.trim() || undefined;

  const result = await searchHybrid(
    {
      store: ctx.store,
      config: ctx.config,
      vectorIndex: ctx.vectorIndex,
      embedPort: ctx.embedPort,
      expandPort: ctx.expandPort,
      rerankPort: ctx.rerankPort,
    },
    normalizedQuery,
    {
      limit: Math.min(body.limit ?? 20, 50),
      minScore: body.minScore,
      collection: body.collection,
      lang: body.lang,
      intent: body.intent?.trim() || undefined,
      candidateLimit:
        body.candidateLimit !== undefined
          ? Math.min(body.candidateLimit, 100)
          : undefined,
      exclude,
      queryModes: normalizedQueryModes,
      noExpand: body.noExpand,
      noRerank: body.noRerank,
      tagsAll,
      tagsAny,
      since: body.since,
      until: body.until,
      categories,
      author,
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

  const rawQuery = body.query.trim();
  if (!rawQuery) {
    return errorResponse("VALIDATION", "Query cannot be empty");
  }

  // Check if answer generation is available
  if (!ctx.capabilities.answer) {
    return errorResponse(
      "UNAVAILABLE",
      "Answer generation not available. No answer model loaded.",
      503
    );
  }

  // Parse tag filters
  let tagsAll: string[] | undefined;
  let tagsAny: string[] | undefined;

  if (body.since !== undefined && typeof body.since !== "string") {
    return errorResponse("VALIDATION", "since must be a string");
  }
  if (body.until !== undefined && typeof body.until !== "string") {
    return errorResponse("VALIDATION", "until must be a string");
  }
  if (body.intent !== undefined && typeof body.intent !== "string") {
    return errorResponse("VALIDATION", "intent must be a string");
  }
  if (body.exclude !== undefined && typeof body.exclude !== "string") {
    return errorResponse(
      "VALIDATION",
      "exclude must be a comma-separated string"
    );
  }
  if (
    body.candidateLimit !== undefined &&
    (typeof body.candidateLimit !== "number" || body.candidateLimit < 1)
  ) {
    return errorResponse(
      "VALIDATION",
      "candidateLimit must be a positive integer"
    );
  }
  if (body.category !== undefined && typeof body.category !== "string") {
    return errorResponse(
      "VALIDATION",
      "category must be a comma-separated string"
    );
  }
  if (body.author !== undefined && typeof body.author !== "string") {
    return errorResponse("VALIDATION", "author must be a string");
  }

  const { queryModes, error: queryModesError } = parseQueryModesInput(
    body.queryModes
  );
  if (queryModesError) {
    return queryModesError;
  }

  const {
    query,
    queryModes: normalizedQueryModes,
    error: structuredQueryError,
  } = normalizeStructuredQueryBody(rawQuery, queryModes);
  if (structuredQueryError) {
    return structuredQueryError;
  }
  const normalizedQuery = query ?? rawQuery;

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

  const categories = body.category
    ? parseCommaSeparatedValues(body.category)
    : undefined;
  const exclude = body.exclude
    ? parseCommaSeparatedValues(body.exclude)
    : undefined;
  const author = body.author?.trim() || undefined;

  const limit = Math.min(body.limit ?? 5, 20);

  // Run hybrid search first
  const searchResult = await searchHybrid(
    {
      store: ctx.store,
      config: ctx.config,
      vectorIndex: ctx.vectorIndex,
      embedPort: ctx.embedPort,
      expandPort: ctx.expandPort,
      rerankPort: ctx.rerankPort,
    },
    normalizedQuery,
    {
      limit,
      collection: body.collection,
      lang: body.lang,
      intent: body.intent?.trim() || undefined,
      noExpand: body.noExpand,
      noRerank: body.noRerank,
      candidateLimit:
        body.candidateLimit !== undefined
          ? Math.min(body.candidateLimit, 100)
          : undefined,
      exclude,
      queryModes: normalizedQueryModes,
      tagsAll,
      tagsAny,
      since: body.since,
      until: body.until,
      categories,
      author,
    }
  );

  if (!searchResult.ok) {
    return errorResponse("RUNTIME", searchResult.error.message, 500);
  }

  const results = searchResult.value.results;

  // Generate grounded answer (requires answer model)
  let answer: string | undefined;
  let citations: Citation[] | undefined;
  let answerContext: AskResult["meta"]["answerContext"] | undefined;
  let answerGenerated = false;

  if (ctx.answerPort) {
    const maxTokens = body.maxAnswerTokens ?? 512;
    const rawResult = await generateGroundedAnswer(
      { genPort: ctx.answerPort, store: ctx.store },
      normalizedQuery,
      results,
      maxTokens
    );

    if (rawResult) {
      const processed = processAnswerResult(rawResult);
      answer = processed.answer;
      citations = processed.citations;
      answerContext = processed.answerContext;
      answerGenerated = true;
    }
  }

  const askResult: AskResult = {
    query: normalizedQuery,
    mode: searchResult.value.meta.vectorsUsed ? "hybrid" : "bm25_only",
    queryLanguage: searchResult.value.meta.queryLanguage ?? "und",
    answer,
    citations,
    results,
    meta: {
      expanded: searchResult.value.meta.expanded ?? false,
      reranked: searchResult.value.meta.reranked ?? false,
      vectorsUsed: searchResult.value.meta.vectorsUsed ?? false,
      intent: searchResult.value.meta.intent,
      candidateLimit: searchResult.value.meta.candidateLimit,
      exclude: searchResult.value.meta.exclude,
      queryModes: searchResult.value.meta.queryModes,
      answerGenerated,
      totalResults: results.length,
      answerContext,
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
// Embed Scheduler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/embed
 * Trigger immediate embedding (bypasses debounce).
 * Used by Cmd+S to force embed after save.
 */
export async function handleEmbed(
  scheduler: EmbedScheduler | null
): Promise<Response> {
  if (!scheduler) {
    return jsonResponse({
      embedded: 0,
      errors: 0,
      note: "No embedding port available",
    });
  }

  const state = scheduler.getState();
  if (state.running) {
    return jsonResponse({
      running: true,
      pendingCount: state.pendingDocCount,
      note: "Embedding already in progress",
    });
  }

  const result = await scheduler.triggerNow();
  if (!result) {
    return jsonResponse({
      embedded: 0,
      errors: 0,
      note: "No embedding port available",
    });
  }

  return jsonResponse({
    embedded: result.embedded,
    errors: result.errors,
  });
}

/**
 * GET /api/embed/status
 * Get current embed scheduler state (for debugging).
 */
export function handleEmbedStatus(scheduler: EmbedScheduler | null): Response {
  if (!scheduler) {
    return jsonResponse({
      available: false,
      pendingDocCount: 0,
      running: false,
    });
  }

  const state = scheduler.getState();
  return jsonResponse({
    available: true,
    ...state,
  });
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
  config: Config,
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

  if (path === "/api/docs/autocomplete") {
    return handleDocsAutocomplete(store, url);
  }

  if (path === "/api/doc") {
    return handleDoc(store, config, url);
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
