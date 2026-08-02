/**
 * REST handlers for section target create/resolve.
 *
 * Consumes shared core create/resolve + transport projection.
 * Does not change GET /api/doc/:id/sections.
 *
 * @module src/serve/routes/section-targets
 */

import type { SqliteAdapter } from "../../store/sqlite/adapter";
import type { DocumentRow } from "../../store/types";

import {
  CANONICAL_URI_EXCEEDS_TRANSPORT_BOUNDS,
  SECTION_TARGET_BOUNDS,
  createSectionTarget,
  extractSections,
  isTransportBoundedCanonicalUri,
  parseSectionTargetCreateSelector,
  parseSectionTargetResolveBody,
  projectSectionTargetCreateResult,
  projectSectionTargetResolveResult,
  resolveSectionTarget,
} from "../../core/sections";
import { parseClosedJson } from "../closed-json";

/** Create body is tiny; resolve wraps a ≤2048-byte target. */
const CREATE_BODY_MAX_BYTES = 1024;
const RESOLVE_BODY_MAX_BYTES = SECTION_TARGET_BOUNDS.maxSerializedBytes + 1024;

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function errorResponse(code: string, message: string, status = 400): Response {
  return jsonResponse({ error: { code, message } }, status);
}

function readRequestedUriFromUrl(req: Request): string | undefined {
  const value = new URL(req.url).searchParams.get("uri");
  return value?.trim() ? value : undefined;
}

async function resolveDocumentReference(
  store: Pick<SqliteAdapter, "getDocumentByDocid" | "getDocumentByUri">,
  docId: string,
  requestedUri?: string
): Promise<
  | { ok: true; value: DocumentRow | null }
  | { ok: false; error: { message: string } }
> {
  if (requestedUri) {
    const byUri = await store.getDocumentByUri(requestedUri);
    if (!byUri.ok) {
      return { ok: false, error: byUri.error };
    }
    return { ok: true, value: byUri.value };
  }

  const byDocid = await store.getDocumentByDocid(docId);
  if (!byDocid.ok) {
    return { ok: false, error: byDocid.error };
  }
  return { ok: true, value: byDocid.value };
}

async function loadDocumentContent(
  store: Pick<
    SqliteAdapter,
    "getDocumentByDocid" | "getDocumentByUri" | "getContent"
  >,
  docId: string,
  req: Request
): Promise<
  | { ok: true; doc: DocumentRow; content: string }
  | { ok: false; response: Response }
> {
  const docResult = await resolveDocumentReference(
    store,
    docId,
    readRequestedUriFromUrl(req)
  );
  if (!docResult.ok) {
    return {
      ok: false,
      response: errorResponse("RUNTIME", docResult.error.message, 500),
    };
  }
  if (!docResult.value) {
    return {
      ok: false,
      response: errorResponse("NOT_FOUND", "Document not found", 404),
    };
  }

  const doc = docResult.value;
  if (!doc.mirrorHash) {
    return {
      ok: false,
      response: errorResponse("NOT_FOUND", "Document content unavailable", 404),
    };
  }

  const contentResult = await store.getContent(doc.mirrorHash);
  if (!contentResult.ok || contentResult.value === null) {
    return {
      ok: false,
      response: errorResponse("RUNTIME", "Mirror content unavailable", 409),
    };
  }

  return { ok: true, doc, content: contentResult.value };
}

/**
 * POST /api/doc/:id/section-targets
 * Body: { anchor?: string, line?: number } — exactly one selector.
 * Canonical document URI always comes from the resolved stored document.
 */
export async function handleCreateSectionTarget(
  store: Pick<
    SqliteAdapter,
    "getDocumentByDocid" | "getDocumentByUri" | "getContent"
  >,
  docId: string,
  req: Request
): Promise<Response> {
  const parsed = await parseClosedJson(req, CREATE_BODY_MAX_BYTES);
  if (!parsed.ok) {
    return errorResponse("VALIDATION", parsed.error, 400);
  }

  const selector = parseSectionTargetCreateSelector(parsed.value);
  if (!selector.ok) {
    return errorResponse("VALIDATION", selector.error, 400);
  }

  const loaded = await loadDocumentContent(store, docId, req);
  if (!loaded.ok) return loaded.response;

  // Top-level response uri shares schema maxLength — reject before create.
  if (!isTransportBoundedCanonicalUri(loaded.doc.uri)) {
    return errorResponse(
      "VALIDATION",
      CANONICAL_URI_EXCEEDS_TRANSPORT_BOUNDS,
      422
    );
  }

  // Canonical identity from stored doc — never from caller.
  const target = await createSectionTarget({
    content: loaded.content,
    uri: loaded.doc.uri,
    ...selector.value,
  });

  if (!target) {
    const sections = extractSections(loaded.content);
    const matched =
      selector.value.anchor !== undefined
        ? sections.some((section) => section.anchor === selector.value.anchor)
        : sections.some((section) => section.line === selector.value.line);
    if (!matched) {
      return errorResponse("NOT_FOUND", "Section not found", 404);
    }
    return errorResponse(
      "VALIDATION",
      "Section target exceeds size bounds",
      422
    );
  }

  return jsonResponse(projectSectionTargetCreateResult(loaded.doc.uri, target));
}

/**
 * POST /api/doc/:id/section-targets/resolve
 * Body: { target: SectionTargetV1 }
 * Resolves against the stored document; URI mismatch yields status missing.
 */
export async function handleResolveSectionTarget(
  store: Pick<
    SqliteAdapter,
    "getDocumentByDocid" | "getDocumentByUri" | "getContent"
  >,
  docId: string,
  req: Request
): Promise<Response> {
  const parsed = await parseClosedJson(req, RESOLVE_BODY_MAX_BYTES);
  if (!parsed.ok) {
    return errorResponse("VALIDATION", parsed.error, 400);
  }

  const body = parseSectionTargetResolveBody(parsed.value);
  if (!body.ok) {
    return errorResponse("VALIDATION", body.error, 400);
  }

  const loaded = await loadDocumentContent(store, docId, req);
  if (!loaded.ok) return loaded.response;

  // Top-level (and citation) uri must fit schema — reject before projection.
  // Citation fail-closed does not repair an unbound top-level uri.
  if (!isTransportBoundedCanonicalUri(loaded.doc.uri)) {
    return errorResponse(
      "VALIDATION",
      CANONICAL_URI_EXCEEDS_TRANSPORT_BOUNDS,
      422
    );
  }

  const resolution = await resolveSectionTarget({
    content: loaded.content,
    target: body.value.target,
    uri: loaded.doc.uri,
  });

  return jsonResponse(
    projectSectionTargetResolveResult(loaded.doc.uri, resolution)
  );
}
