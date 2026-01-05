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

/**
 * Parse and validate a positive integer query param.
 * Returns default if missing, NaN, or out of bounds.
 */
function parsePositiveInt(
  value: string | null,
  defaultValue: number,
  min: number,
  max: number
): number {
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

/**
 * Parse and validate a float query param in [0, 1].
 * Returns default if missing, NaN, or out of bounds.
 */
function parseThreshold(value: string | null, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(0, Math.min(1, parsed));
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
  const limitNodes = parsePositiveInt(
    url.searchParams.get("limit"),
    2000,
    1,
    5000
  );
  const limitEdges = parsePositiveInt(
    url.searchParams.get("edgeLimit"),
    10000,
    1,
    50000
  );
  const includeSimilar = parseBoolean(
    url.searchParams.get("includeSimilar"),
    false
  );
  const threshold = parseThreshold(url.searchParams.get("threshold"), 0.7);
  const linkedOnly = parseBoolean(url.searchParams.get("linkedOnly"), true);
  const similarTopK = parsePositiveInt(
    url.searchParams.get("similarTopK"),
    5,
    1,
    20
  );

  const options: GetGraphOptions = {
    collection,
    limitNodes,
    limitEdges,
    includeSimilar,
    threshold,
    linkedOnly,
    similarTopK,
  };

  const result = await store.getGraph(options);

  if (!result.ok) {
    return errorResponse("RUNTIME", result.error.message, 500);
  }

  return jsonResponse(result.value satisfies GraphResponse);
}
