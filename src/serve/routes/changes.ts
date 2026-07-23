/** Read-only REST handlers for knowledge change, diff, and impact services. */

import type { KnowledgeImpactInput } from "../../core/knowledge-delta";
import type { StorePort } from "../../store/types";

import {
  analyzeKnowledgeImpact,
  getKnowledgeDiff,
  listKnowledgeChanges,
} from "../../core/knowledge-delta";

const errorResponse = (
  code: "VALIDATION" | "RUNTIME",
  message: string
): Response =>
  Response.json(
    { error: { code, message } },
    { status: code === "VALIDATION" ? 400 : 500 }
  );

const parsePositiveInt = (
  url: URL,
  name: string
): number | undefined | Response => {
  const raw = url.searchParams.get(name);
  if (raw === null) return;
  if (!/^\d+$/.test(raw)) {
    return errorResponse("VALIDATION", `${name} must be a positive integer`);
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0
    ? value
    : errorResponse("VALIDATION", `${name} must be a positive integer`);
};

export async function handleChanges(
  store: StorePort,
  url: URL
): Promise<Response> {
  const limit = parsePositiveInt(url, "limit");
  if (limit instanceof Response) return limit;
  const result = await listKnowledgeChanges(store, {
    since: url.searchParams.get("since") ?? undefined,
    collection: url.searchParams.get("collection") ?? undefined,
    limit,
  });
  if (!result.success) {
    return errorResponse(
      result.isValidation ? "VALIDATION" : "RUNTIME",
      result.error
    );
  }
  return Response.json(result.data);
}

export async function handleDiff(
  store: StorePort,
  url: URL
): Promise<Response> {
  const ref = url.searchParams.get("ref")?.trim();
  if (!ref) return errorResponse("VALIDATION", "ref is required");
  const result = await getKnowledgeDiff(
    store,
    ref,
    url.searchParams.get("change") ?? undefined
  );
  if (!result.success) {
    return errorResponse(
      result.isValidation ? "VALIDATION" : "RUNTIME",
      result.error
    );
  }
  return Response.json(result.data);
}

export async function handleImpact(
  store: StorePort,
  url: URL
): Promise<Response> {
  const ref = url.searchParams.get("ref")?.trim();
  if (!ref) return errorResponse("VALIDATION", "ref is required");
  const input: KnowledgeImpactInput = {};
  for (const [queryName, inputName] of [
    ["maxDepth", "maxDepth"],
    ["maxNodes", "maxNodes"],
    ["maxEdges", "maxEdges"],
    ["frontierLimit", "frontierLimit"],
    ["visitedLimit", "visitedLimit"],
  ] as const) {
    const value = parsePositiveInt(url, queryName);
    if (value instanceof Response) return value;
    if (value !== undefined) input[inputName] = value;
  }
  const result = await analyzeKnowledgeImpact(store, ref, input);
  if (!result.success) {
    return errorResponse(
      result.isValidation ? "VALIDATION" : "RUNTIME",
      result.error
    );
  }
  return Response.json(result.data);
}
