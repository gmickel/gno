/**
 * REST API route for knowledge graph.
 *
 * @module src/serve/routes/graph
 */

import type { Config } from "../../config/types";
import type { SqliteAdapter } from "../../store/sqlite/adapter";
import type {
  GetGraphOptions,
  GraphQueryDirection,
  GraphQueryResult,
  GraphResult,
} from "../../store/types";

import { normalizeContentTypes } from "../../config";
import { diagnoseGraphQuery } from "../../core/graph-query";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface GraphResponse extends GraphResult {}

export interface GraphQueryResponse extends GraphQueryResult {}

interface GraphQueryRequestBody {
  doc?: string;
  root?: string;
  direction?: GraphQueryDirection;
  edgeType?: string;
  relation?: string;
  maxDepth?: number;
  depth?: number;
  maxNodes?: number;
  frontierLimit?: number;
  visitedLimit?: number;
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

function parseBodyPositiveInt(
  name: string,
  value: number | undefined,
  defaultValue: number,
  min: number,
  max: number
): ParseResult {
  if (value === undefined) return { ok: true, value: defaultValue };
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return {
      ok: false,
      message: `${name} must be an integer between ${min} and ${max}`,
    };
  }
  if (value < min || value > max) {
    return {
      ok: false,
      message: `${name} must be between ${min} and ${max}`,
    };
  }
  return { ok: true, value };
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

/**
 * POST /api/graph/query
 * Returns bounded typed-edge traversal from one resolved root document.
 */
export async function handleGraphQuery(
  store: SqliteAdapter,
  config: Config,
  req: Request
): Promise<Response> {
  let body: GraphQueryRequestBody;
  try {
    body = (await req.json()) as GraphQueryRequestBody;
  } catch {
    return errorResponse("VALIDATION", "Invalid JSON body", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse("VALIDATION", "JSON body must be an object", 400);
  }

  const docRef = body.doc ?? body.root;
  if (!docRef || typeof docRef !== "string") {
    return errorResponse("VALIDATION", "Missing or invalid doc", 400);
  }
  const rootRef = docRef.trim();
  if (!rootRef) {
    return errorResponse("VALIDATION", "doc cannot be empty", 400);
  }

  const direction = body.direction ?? "both";
  if (!["out", "in", "both"].includes(direction)) {
    return errorResponse(
      "VALIDATION",
      "direction must be 'out', 'in', or 'both'",
      400
    );
  }

  if (body.edgeType !== undefined && typeof body.edgeType !== "string") {
    return errorResponse("VALIDATION", "edgeType must be a string", 400);
  }
  if (body.relation !== undefined && typeof body.relation !== "string") {
    return errorResponse("VALIDATION", "relation must be a string", 400);
  }
  const edgeTypeValue = body.edgeType?.trim();
  const relationValue = body.relation?.trim();
  const edgeType = edgeTypeValue || relationValue || undefined;
  if (
    (body.edgeType !== undefined || body.relation !== undefined) &&
    !edgeType
  ) {
    return errorResponse(
      "VALIDATION",
      "edgeType/relation cannot be empty",
      400
    );
  }
  if (edgeTypeValue && relationValue && edgeTypeValue !== relationValue) {
    return errorResponse(
      "VALIDATION",
      "edgeType and relation are aliases and must match when both are provided",
      400
    );
  }

  const maxDepthResult = parseBodyPositiveInt(
    "maxDepth",
    body.maxDepth ?? body.depth,
    2,
    1,
    6
  );
  if (!maxDepthResult.ok) {
    return errorResponse("VALIDATION", maxDepthResult.message, 400);
  }
  const maxNodesResult = parseBodyPositiveInt(
    "maxNodes",
    body.maxNodes,
    100,
    1,
    1000
  );
  if (!maxNodesResult.ok) {
    return errorResponse("VALIDATION", maxNodesResult.message, 400);
  }
  const frontierLimitResult = parseBodyPositiveInt(
    "frontierLimit",
    body.frontierLimit,
    100,
    1,
    1000
  );
  if (!frontierLimitResult.ok) {
    return errorResponse("VALIDATION", frontierLimitResult.message, 400);
  }
  const visitedLimitResult = parseBodyPositiveInt(
    "visitedLimit",
    body.visitedLimit,
    500,
    1,
    5000
  );
  if (!visitedLimitResult.ok) {
    return errorResponse("VALIDATION", visitedLimitResult.message, 400);
  }

  const result = await diagnoseGraphQuery(store, rootRef, {
    direction,
    edgeType,
    maxDepth: maxDepthResult.value,
    maxNodes: maxNodesResult.value,
    frontierLimit: frontierLimitResult.value,
    visitedLimit: visitedLimitResult.value,
    contentTypeRules: normalizeContentTypes(config.contentTypes ?? []).rules,
  });
  if (!result.success) {
    return errorResponse(
      result.isValidation ? "VALIDATION" : "RUNTIME",
      result.error,
      result.isValidation ? 400 : 500
    );
  }

  return jsonResponse(result.data satisfies GraphQueryResponse);
}
