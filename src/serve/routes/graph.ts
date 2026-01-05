/**
 * REST API route for knowledge graph.
 *
 * @module src/serve/routes/graph
 */

import type { SqliteAdapter } from "../../store/sqlite/adapter";
import type { GetGraphOptions, GraphResult } from "../../store/types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface GraphResponse extends GraphResult {}

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
    return {
      ok: false,
      message: `${name} must be between ${min} and ${max}`,
    };
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

/**
 * Parse boolean query param (true if "true" or "1", false otherwise).
 */
function parseBoolean(value: string | null, defaultValue: boolean): boolean {
  if (!value) return defaultValue;
  return value === "true" || value === "1";
}

// ─────────────────────────────────────────────────────────────────────────────
// Route Handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/graph
 * Returns knowledge graph of document links.
 *
 * Query params:
 *   collection - filter to single collection
 *   limit - max nodes (default 2000, max 5000)
 *   edgeLimit - max edges (default 10000, max 50000)
 *   includeSimilar - include similarity edges (default false)
 *   threshold - similarity threshold 0-1 (default 0.7)
 *   linkedOnly - exclude isolated nodes (default true)
 *   similarTopK - similar docs per node (default 5, max 20)
 */
export async function handleGraph(
  store: SqliteAdapter,
  url: URL
): Promise<Response> {
  // Parse query params
  const collection = url.searchParams.get("collection") || undefined;
  const limitNodesResult = parsePositiveInt(
    "limit",
    url.searchParams.get("limit"),
    2000,
    1,
    5000
  );
  if (!limitNodesResult.ok) {
    return errorResponse("VALIDATION", limitNodesResult.message, 400);
  }
  const limitEdgesResult = parsePositiveInt(
    "edgeLimit",
    url.searchParams.get("edgeLimit"),
    10000,
    1,
    50000
  );
  if (!limitEdgesResult.ok) {
    return errorResponse("VALIDATION", limitEdgesResult.message, 400);
  }
  const includeSimilar = parseBoolean(
    url.searchParams.get("includeSimilar"),
    false
  );
  const thresholdResult = parseThreshold(
    "threshold",
    url.searchParams.get("threshold"),
    0.7
  );
  if (!thresholdResult.ok) {
    return errorResponse("VALIDATION", thresholdResult.message, 400);
  }
  const linkedOnly = parseBoolean(url.searchParams.get("linkedOnly"), true);
  const similarTopKResult = parsePositiveInt(
    "similarTopK",
    url.searchParams.get("similarTopK"),
    5,
    1,
    20
  );
  if (!similarTopKResult.ok) {
    return errorResponse("VALIDATION", similarTopKResult.message, 400);
  }

  const options: GetGraphOptions = {
    collection,
    limitNodes: limitNodesResult.value,
    limitEdges: limitEdgesResult.value,
    includeSimilar,
    threshold: thresholdResult.value,
    linkedOnly,
    similarTopK: similarTopKResult.value,
  };

  const result = await store.getGraph(options);

  if (!result.ok) {
    return errorResponse("RUNTIME", result.error.message, 500);
  }

  return jsonResponse(result.value satisfies GraphResponse);
}
