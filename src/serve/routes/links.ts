/**
 * REST API routes for document links (outgoing, backlinks, similar).
 *
 * @module src/serve/routes/links
 */

import type { SqliteAdapter } from "../../store/sqlite/adapter";
import type { ServerContext } from "../context";

import { decodeEmbedding } from "../../store/vector/sqlite-vec";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface LinkResponse {
  links: Array<{
    targetRef: string;
    targetRefNorm: string;
    targetAnchor?: string;
    targetCollection?: string;
    linkType: "wiki" | "markdown";
    linkText?: string;
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
    source: "parsed" | "user" | "suggested";
    /** Whether target doc was resolved (found in index) */
    resolved?: boolean;
    /** Resolved target document ID (if found) */
    resolvedDocid?: string;
    /** Resolved target URI (if found) */
    resolvedUri?: string;
    /** Resolved target title (if found) */
    resolvedTitle?: string;
  }>;
  meta: {
    docid: string;
    totalLinks: number;
    resolvedCount: number;
    resolutionAvailable: boolean;
    typeFilter?: "wiki" | "markdown";
  };
}

export interface BacklinkResponse {
  backlinks: Array<{
    sourceDocid: string;
    sourceUri: string;
    sourceTitle?: string;
    linkText?: string;
    startLine: number;
    startCol: number;
  }>;
  meta: {
    docid: string;
    totalBacklinks: number;
  };
}

export interface SimilarDocResponse {
  similar: Array<{
    docid: string;
    uri: string;
    title?: string;
    collection: string;
    score: number;
  }>;
  meta: {
    docid: string;
    totalResults: number;
    limit: number;
    threshold: number;
    crossCollection: boolean;
  };
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

type ParseResult = { ok: true; value: number } | { ok: false; message: string };

function parsePositiveInt(
  name: string,
  value: string | null,
  defaultValue: number,
  min: number,
  max: number
): ParseResult {
  if (!value) return { ok: true, value: defaultValue };
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return {
      ok: false,
      message: `${name} must be an integer between ${min} and ${max}`,
    };
  }
  if (parsed < min || parsed > max) {
    return { ok: false, message: `${name} must be between ${min} and ${max}` };
  }
  return { ok: true, value: parsed };
}

function parseThreshold(
  name: string,
  value: string | null,
  defaultValue: number
): ParseResult {
  if (!value) return { ok: true, value: defaultValue };
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return { ok: false, message: `${name} must be a number between 0 and 1` };
  }
  if (parsed < 0 || parsed > 1) {
    return { ok: false, message: `${name} must be between 0 and 1` };
  }
  return { ok: true, value: parsed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Route Handlers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/doc/:id/links
 * List outgoing links from a document with resolved target info.
 * Query params: ?type=wiki|markdown (optional filter)
 */
export async function handleDocLinks(
  store: SqliteAdapter,
  docId: string,
  url: URL
): Promise<Response> {
  // Get document
  const docResult = await store.getDocumentByDocid(docId);
  if (!docResult.ok) {
    return errorResponse("RUNTIME", docResult.error.message, 500);
  }
  if (!docResult.value) {
    return errorResponse("NOT_FOUND", "Document not found", 404);
  }

  const doc = docResult.value;

  // Get links
  const linksResult = await store.getLinksForDoc(doc.id);
  if (!linksResult.ok) {
    return errorResponse("RUNTIME", linksResult.error.message, 500);
  }

  let links = linksResult.value;

  // Validate and apply type filter
  const typeParam = url.searchParams.get("type");
  let validatedType: "wiki" | "markdown" | undefined;

  if (typeParam) {
    if (typeParam !== "wiki" && typeParam !== "markdown") {
      return errorResponse(
        "VALIDATION",
        `Invalid type filter: ${typeParam}. Must be 'wiki' or 'markdown'`,
        400
      );
    }
    validatedType = typeParam;
    links = links.filter((l) => l.linkType === validatedType);
  }

  // Sort by position for deterministic output
  links.sort((a, b) => {
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    return a.startCol - b.startCol;
  });

  // Resolve targets - batch query for efficiency
  // Note: targetCollection may be empty string "" for same-collection links
  const resolvedResult = await store.resolveLinks(
    links.map((l) => ({
      targetRefNorm: l.targetRefNorm,
      targetCollection: l.targetCollection || doc.collection,
      linkType: l.linkType,
    }))
  );
  const resolutionAvailable = resolvedResult.ok;
  const resolvedTargets = resolutionAvailable ? resolvedResult.value : null;

  const response: LinkResponse = {
    links: links.map((l, idx) => {
      const resolved = resolvedTargets?.[idx] ?? null;
      return {
        targetRef: l.targetRef,
        targetRefNorm: l.targetRefNorm,
        // Only include optional fields if present
        ...(l.targetAnchor && { targetAnchor: l.targetAnchor }),
        ...(l.targetCollection && { targetCollection: l.targetCollection }),
        linkType: l.linkType,
        ...(l.linkText && { linkText: l.linkText }),
        startLine: l.startLine,
        startCol: l.startCol,
        endLine: l.endLine,
        endCol: l.endCol,
        source: l.source,
        ...(resolutionAvailable && {
          // Resolved target info
          resolved: resolved !== null,
          ...(resolved && {
            resolvedDocid: resolved.docid,
            resolvedUri: resolved.uri,
            resolvedTitle: resolved.title ?? undefined,
          }),
        }),
      };
    }),
    meta: {
      docid: doc.docid,
      totalLinks: links.length,
      resolvedCount: resolvedTargets
        ? resolvedTargets.filter(Boolean).length
        : 0,
      resolutionAvailable,
      ...(validatedType && { typeFilter: validatedType }),
    },
  };

  return jsonResponse(response);
}

/**
 * GET /api/doc/:id/backlinks
 * List documents that link TO this document.
 */
export async function handleDocBacklinks(
  store: SqliteAdapter,
  docId: string
): Promise<Response> {
  // Get document
  const docResult = await store.getDocumentByDocid(docId);
  if (!docResult.ok) {
    return errorResponse("RUNTIME", docResult.error.message, 500);
  }
  if (!docResult.value) {
    return errorResponse("NOT_FOUND", "Document not found", 404);
  }

  const doc = docResult.value;

  // Get backlinks
  const backlinksResult = await store.getBacklinksForDoc(doc.id);
  if (!backlinksResult.ok) {
    return errorResponse("RUNTIME", backlinksResult.error.message, 500);
  }

  // Sort for deterministic output
  const backlinks = [...backlinksResult.value].sort((a, b) => {
    if (a.sourceDocUri !== b.sourceDocUri) {
      return a.sourceDocUri.localeCompare(b.sourceDocUri);
    }
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    return a.startCol - b.startCol;
  });

  const response: BacklinkResponse = {
    backlinks: backlinks.map((b) => ({
      sourceDocid: b.sourceDocid,
      sourceUri: b.sourceDocUri,
      ...(b.sourceDocTitle && { sourceTitle: b.sourceDocTitle }),
      ...(b.linkText && { linkText: b.linkText }),
      startLine: b.startLine,
      startCol: b.startCol,
    })),
    meta: {
      docid: doc.docid,
      totalBacklinks: backlinks.length,
    },
  };

  return jsonResponse(response);
}

/**
 * GET /api/doc/:id/similar
 * Find semantically similar documents using stored vector embeddings.
 * Query params:
 *   ?limit=5 (default 5, max 20)
 *   ?threshold=0.5 (min similarity score 0-1, default 0.5)
 *   ?crossCollection=true (search across all collections, default false)
 *
 * Algorithm: seq=0 embedding (fallback to first available) -> vector search -> exclude self
 */
export async function handleDocSimilar(
  ctx: ServerContext,
  docId: string,
  url: URL
): Promise<Response> {
  const store = ctx.store;

  // Get document
  const docResult = await store.getDocumentByDocid(docId);
  if (!docResult.ok) {
    return errorResponse("RUNTIME", docResult.error.message, 500);
  }
  if (!docResult.value) {
    return errorResponse("NOT_FOUND", "Document not found", 404);
  }

  const doc = docResult.value;

  // Check vector search availability
  if (!ctx.vectorIndex?.searchAvailable) {
    return errorResponse(
      "UNAVAILABLE",
      "Similar docs requires vector search with sqlite-vec. Run: gno embed",
      503
    );
  }

  const limitResult = parsePositiveInt(
    "limit",
    url.searchParams.get("limit"),
    5,
    1,
    20
  );
  if (!limitResult.ok) {
    return errorResponse("VALIDATION", limitResult.message, 400);
  }
  const thresholdResult = parseThreshold(
    "threshold",
    url.searchParams.get("threshold"),
    0.5
  );
  if (!thresholdResult.ok) {
    return errorResponse("VALIDATION", thresholdResult.message, 400);
  }
  const limit = limitResult.value;
  const threshold = thresholdResult.value;
  const crossCollection = url.searchParams.get("crossCollection") === "true";

  // Check document has content
  if (!doc.mirrorHash) {
    return jsonResponse({
      similar: [],
      meta: {
        docid: doc.docid,
        totalResults: 0,
        limit,
        threshold,
        crossCollection,
      },
    } satisfies SimilarDocResponse);
  }

  // Get embedding model from context
  const embedModel = ctx.vectorIndex.model;

  // Get document embedding from content_vectors (prefer seq=0)
  const db = store.getRawDb();

  interface VectorRow {
    embedding: Uint8Array;
  }

  const vectorRow = db
    .query<VectorRow, [string, string]>(
      "SELECT embedding FROM content_vectors WHERE mirror_hash = ? AND model = ? AND seq = 0 LIMIT 1"
    )
    .get(doc.mirrorHash, embedModel);

  const fallbackRow =
    vectorRow ??
    db
      .query<VectorRow, [string, string]>(
        "SELECT embedding FROM content_vectors WHERE mirror_hash = ? AND model = ? ORDER BY seq LIMIT 1"
      )
      .get(doc.mirrorHash, embedModel);

  if (!fallbackRow) {
    return jsonResponse({
      similar: [],
      meta: {
        docid: doc.docid,
        totalResults: 0,
        limit,
        threshold,
        crossCollection,
      },
    } satisfies SimilarDocResponse);
  }

  let dimensions: number;
  let embedding: Float32Array;

  try {
    embedding = decodeEmbedding(fallbackRow.embedding);
    dimensions = embedding.length;
  } catch (e) {
    return errorResponse(
      "RUNTIME",
      `Invalid stored embedding data: ${e instanceof Error ? e.message : String(e)}`,
      500
    );
  }

  // Normalize embedding for cosine similarity
  let norm = 0;
  for (let i = 0; i < dimensions; i++) {
    const val = embedding[i] ?? 0;
    norm += val * val;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dimensions; i++) {
      embedding[i] = (embedding[i] ?? 0) / norm;
    }
  }

  // Search for similar docs (request extra to account for self-exclusion, filtering)
  const candidateLimit = Math.min(limit * 20, 200);
  const searchResult = await ctx.vectorIndex.searchNearest(
    embedding,
    candidateLimit,
    {}
  );

  if (!searchResult.ok) {
    return errorResponse("RUNTIME", searchResult.error.message, 500);
  }

  // Get all docs for lookup (single query)
  const docsResult = await store.listDocuments(
    crossCollection ? undefined : doc.collection
  );
  if (!docsResult.ok) {
    return errorResponse("RUNTIME", docsResult.error.message, 500);
  }

  const docsByHash = new Map(
    docsResult.value
      .filter((d) => d.mirrorHash && d.active)
      .map((d) => [d.mirrorHash!, d])
  );

  // Build similar docs list, excluding self
  const similar: SimilarDocResponse["similar"] = [];
  const seenDocids = new Set<string>();

  for (const vec of searchResult.value) {
    if (similar.length >= limit) break;

    const similarDoc = docsByHash.get(vec.mirrorHash);
    if (!similarDoc) continue;

    // Exclude self
    if (similarDoc.docid === doc.docid) continue;

    // Skip duplicates
    if (seenDocids.has(similarDoc.docid)) continue;

    // Compute similarity score from cosine distance
    // sqlite-vec with cosine metric returns distance where similarity = 1 - distance
    const score = Math.max(0, Math.min(1, 1 - vec.distance));
    if (score < threshold) continue;

    similar.push({
      docid: similarDoc.docid,
      uri: similarDoc.uri,
      ...(similarDoc.title && { title: similarDoc.title }),
      collection: similarDoc.collection,
      score,
    });

    seenDocids.add(similarDoc.docid);
  }

  // Sort by score descending
  similar.sort((a, b) => b.score - a.score);

  const response: SimilarDocResponse = {
    similar: similar.slice(0, limit),
    meta: {
      docid: doc.docid,
      totalResults: similar.length,
      limit,
      threshold,
      crossCollection,
    },
  };

  return jsonResponse(response);
}
