/**
 * REST API routes for GNO web UI.
 * All routes return JSON with consistent error format.
 *
 * @module src/serve/routes/api
 */

import { searchBm25 } from '../../pipeline/search';
import type { SearchOptions } from '../../pipeline/types';
import type { SqliteAdapter } from '../../store/sqlite/adapter';

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
    return errorResponse('RUNTIME', result.error.message, 500);
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
    return errorResponse('RUNTIME', result.error.message, 500);
  }

  return jsonResponse(
    result.value.map((c) => ({
      name: c.name,
      path: c.path,
    }))
  );
}

/**
 * GET /api/docs
 * Query params: collection, limit (default 20), offset (default 0)
 * Returns paginated document list.
 */
export async function handleDocs(
  store: SqliteAdapter,
  url: URL
): Promise<Response> {
  const collection = url.searchParams.get('collection') || undefined;

  // Validate limit: positive integer, max 100
  const limitParam = Number(url.searchParams.get('limit'));
  if (
    url.searchParams.has('limit') &&
    (Number.isNaN(limitParam) || limitParam < 1)
  ) {
    return errorResponse('VALIDATION', 'limit must be a positive integer');
  }
  const limit = Math.min(limitParam || 20, 100);

  // Validate offset: non-negative integer
  const offsetParam = Number(url.searchParams.get('offset'));
  if (
    url.searchParams.has('offset') &&
    (Number.isNaN(offsetParam) || offsetParam < 0)
  ) {
    return errorResponse('VALIDATION', 'offset must be a non-negative integer');
  }
  const offset = offsetParam || 0;

  const result = await store.listDocuments(collection);

  if (!result.ok) {
    return errorResponse('RUNTIME', result.error.message, 500);
  }

  // Apply pagination in memory (store doesn't support it yet)
  const docs = result.value.slice(offset, offset + limit);

  return jsonResponse({
    documents: docs.map((doc) => ({
      docid: doc.docid,
      uri: doc.uri,
      title: doc.title,
      collection: doc.collection,
      relPath: doc.relPath,
      sourceExt: doc.sourceExt,
      sourceMime: doc.sourceMime,
      updatedAt: doc.updatedAt,
    })),
    total: result.value.length,
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
  const uri = url.searchParams.get('uri');
  if (!uri) {
    return errorResponse('VALIDATION', 'Missing uri parameter');
  }

  const docResult = await store.getDocumentByUri(uri);
  if (!docResult.ok) {
    return errorResponse('RUNTIME', docResult.error.message, 500);
  }
  if (!docResult.value) {
    return errorResponse('NOT_FOUND', 'Document not found', 404);
  }

  const doc = docResult.value;
  let content: string | null = null;

  if (doc.mirrorHash) {
    const contentResult = await store.getContent(doc.mirrorHash);
    if (contentResult.ok && contentResult.value) {
      content = contentResult.value;
    }
  }

  return jsonResponse({
    docid: doc.docid,
    uri: doc.uri,
    title: doc.title,
    content,
    contentAvailable: content !== null,
    collection: doc.collection,
    relPath: doc.relPath,
    source: {
      mime: doc.sourceMime,
      ext: doc.sourceExt,
      modifiedAt: doc.sourceMtime,
      sizeBytes: doc.sourceSize,
    },
  });
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
    return errorResponse('VALIDATION', 'Invalid JSON body');
  }

  if (!body.query || typeof body.query !== 'string') {
    return errorResponse('VALIDATION', 'Missing or invalid query');
  }

  const query = body.query.trim();
  if (!query) {
    return errorResponse('VALIDATION', 'Query cannot be empty');
  }

  // Validate limit: positive integer
  if (
    body.limit !== undefined &&
    (typeof body.limit !== 'number' || body.limit < 1)
  ) {
    return errorResponse('VALIDATION', 'limit must be a positive integer');
  }

  // Validate minScore: number between 0 and 1
  if (
    body.minScore !== undefined &&
    (typeof body.minScore !== 'number' ||
      body.minScore < 0 ||
      body.minScore > 1)
  ) {
    return errorResponse(
      'VALIDATION',
      'minScore must be a number between 0 and 1'
    );
  }

  // Only BM25 supported in web UI (vector/hybrid require LLM ports)
  const options: SearchOptions = {
    limit: Math.min(body.limit || 10, 50),
    minScore: body.minScore,
    collection: body.collection,
  };

  const result = await searchBm25(store, query, options);

  if (!result.ok) {
    return errorResponse('RUNTIME', result.error.message, 500);
  }

  return jsonResponse(result.value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Route an API request to the appropriate handler.
 * Returns null if the path is not an API route.
 */
export async function routeApi(
  store: SqliteAdapter,
  req: Request,
  url: URL
): Promise<Response | null> {
  const path = url.pathname;

  // CSRF protection: validate Origin for non-GET requests
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.get('origin');
    const secFetchSite = req.headers.get('sec-fetch-site');

    // Reject cross-origin requests (allow same-origin or no origin for curl)
    if (origin) {
      const originUrl = new URL(origin);
      if (
        originUrl.hostname !== '127.0.0.1' &&
        originUrl.hostname !== 'localhost'
      ) {
        return errorResponse(
          'FORBIDDEN',
          'Cross-origin requests not allowed',
          403
        );
      }
    } else if (
      secFetchSite &&
      secFetchSite !== 'same-origin' &&
      secFetchSite !== 'none'
    ) {
      return errorResponse(
        'FORBIDDEN',
        'Cross-origin requests not allowed',
        403
      );
    }
  }

  if (path === '/api/health') {
    return handleHealth();
  }

  if (path === '/api/status') {
    return handleStatus(store);
  }

  if (path === '/api/collections') {
    return handleCollections(store);
  }

  if (path === '/api/docs') {
    return handleDocs(store, url);
  }

  if (path === '/api/doc') {
    return handleDoc(store, url);
  }

  if (path === '/api/search' && req.method === 'POST') {
    return handleSearch(store, req);
  }

  // Unknown API route
  if (path.startsWith('/api/')) {
    return errorResponse('NOT_FOUND', `Unknown API endpoint: ${path}`, 404);
  }

  return null;
}
