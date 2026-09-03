/** 2026-07-28 (sessionless) leg of the resident Streamable HTTP transport. */

import {
  createMcpHandler,
  isLegacyRequest,
  type McpServer,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";

import type { ToolContext } from "./context";

export const MCP_LEGACY_PROTOCOL_VERSION = "2025-11-25";
export const MCP_MODERN_PROTOCOL_VERSION = "2026-07-28";
/**
 * The exact protocol revisions GNO speaks. Membership here is the only test a
 * revision label passes; there is no ordering, so a future-dated or
 * non-date label (`2027-01-01`, `abc`) is never treated as modern.
 */
export const MCP_SUPPORTED_PROTOCOL_REVISIONS: ReadonlySet<string> = new Set([
  MCP_LEGACY_PROTOCOL_VERSION,
  MCP_MODERN_PROTOCOL_VERSION,
]);
/** Revisions served by the sessionless leg. */
const MCP_MODERN_PROTOCOL_REVISIONS: ReadonlySet<string> = new Set([
  MCP_MODERN_PROTOCOL_VERSION,
]);
/**
 * Modern methods the SDK serves as a long-lived stream. GNO wires no change
 * event source to them, and a stream that never ends would pin a capacity
 * slot and an admission handle for the life of the connection, so they are
 * refused before the SDK handler is reached.
 */
const MCP_UNSUPPORTED_MODERN_STREAM_METHODS: ReadonlySet<string> = new Set([
  "subscriptions/listen",
]);
const MCP_PROTOCOL_VERSION_HEADER = "mcp-protocol-version";
const MCP_SESSION_HEADER = "mcp-session-id";
/** SEP-2243 `HeaderMismatch`: the standard headers and the body disagree. */
const HEADER_MISMATCH_ERROR_CODE = -32_020;
const INVALID_REQUEST_ERROR_CODE = -32_600;
const METHOD_NOT_FOUND_ERROR_CODE = -32_601;
const SERVER_ERROR_CODE = -32_000;
/** The 2026-07-28 HTTP ladder answers a pre-dispatch method-not-found with 404. */
const METHOD_NOT_FOUND_HTTP_STATUS = 404;

export interface ModernMcpHandler {
  fetch(request: Request, parsedBody: unknown): Promise<Response>;
  close(): Promise<void>;
}

function jsonRpcError(
  status: number,
  code: number,
  message: string,
  data?: unknown,
  id: string | number | null = null
): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code, message, ...(data === undefined ? {} : { data }) },
      id,
    },
    { status }
  );
}

function jsonRpcMessages(parsedBody: unknown): unknown[] {
  return Array.isArray(parsedBody) ? parsedBody : [parsedBody];
}

function methodOf(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const { method } = message as { method?: unknown };
  return typeof method === "string" ? method : undefined;
}

function echoableId(message: unknown): string | number | null {
  if (typeof message !== "object" || message === null) return null;
  const { id } = message as { id?: unknown };
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function carriesEnvelopeClaim(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const meta = (message as { params?: { _meta?: unknown } }).params?._meta;
  return (
    typeof meta === "object" &&
    meta !== null &&
    PROTOCOL_VERSION_META_KEY in meta
  );
}

function namesModernRevision(request: Request): boolean {
  const header = request.headers.get(MCP_PROTOCOL_VERSION_HEADER);
  return header !== null && MCP_MODERN_PROTOCOL_REVISIONS.has(header);
}

/**
 * Whether the transport routes this request to the 2026-07-28 sessionless
 * leg instead of the 2025-era session path.
 *
 * The SDK's own classifier decides legacy-ness so the branch can never
 * disagree with `createMcpHandler`. Only a request that actually claims the
 * modern era - a per-request `_meta` envelope claim (well-formed or not), or
 * an `MCP-Protocol-Version` header naming a modern revision - is served
 * modern; a body the classifier rejects without any such claim keeps the
 * legacy path's established error answers. Body-less methods (GET, DELETE)
 * are 2025 session operations and always legacy; the modern era has no
 * sessions.
 */
export async function isModernMcpRequest(
  request: Request,
  parsedBody: unknown
): Promise<boolean> {
  if (request.method !== "POST") return false;
  if (await isLegacyRequest(request, parsedBody)) return false;
  return (
    jsonRpcMessages(parsedBody).some(carriesEnvelopeClaim) ||
    namesModernRevision(request)
  );
}

/**
 * Refuse a modern request for a method the SDK would serve as a long-lived
 * stream (`subscriptions/listen`). The answer is the 2026-07-28 ladder's
 * pre-dispatch method-not-found (`404`, `-32601`) with the request id echoed,
 * so the client learns the method is absent here rather than waiting on a
 * stream that would never carry an event. The check runs before dispatch and
 * releases nothing itself: the caller finishes the request like any other
 * rejection, so no capacity slot or admission handle outlives the answer.
 */
export function rejectUnsupportedModernStream(
  parsedBody: unknown
): Response | undefined {
  const message = jsonRpcMessages(parsedBody).find((candidate) => {
    const method = methodOf(candidate);
    return (
      method !== undefined && MCP_UNSUPPORTED_MODERN_STREAM_METHODS.has(method)
    );
  });
  if (message === undefined) return undefined;
  const method = methodOf(message) ?? "";
  return jsonRpcError(
    METHOD_NOT_FOUND_HTTP_STATUS,
    METHOD_NOT_FOUND_ERROR_CODE,
    `Method not found: ${method} is not served by this endpoint; GNO change events are not wired to subscription streams`,
    { method },
    echoableId(message)
  );
}

/**
 * GNO-owned pre-dispatch checks for a modern-classified request.
 *
 * - A POST that is not `application/json` is refused with 415, as the
 *   session transport refuses it, before the SDK's modern leg sees it.
 * - The 2026-07-28 Streamable HTTP binding requires `MCP-Protocol-Version`
 *   on every request; a modern envelope without the header is refused, never
 *   served from the body claim alone.
 * - Sessions are 2025-era state. A modern request that names one is a
 *   protocol confusion and is rejected before it can touch another
 *   identity's session.
 */
export function rejectMalformedModernRequest(
  request: Request
): Response | undefined {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return jsonRpcError(
      415,
      SERVER_ERROR_CODE,
      "Unsupported Media Type: Content-Type must be application/json"
    );
  }
  if (request.headers.has(MCP_SESSION_HEADER)) {
    return jsonRpcError(
      400,
      INVALID_REQUEST_ERROR_CODE,
      `Bad Request: Mcp-Session-Id is not valid on a ${MCP_MODERN_PROTOCOL_VERSION} request; sessions are 2025-era only`
    );
  }
  if (!request.headers.has(MCP_PROTOCOL_VERSION_HEADER)) {
    const body = `the body envelope claims protocol revision ${MCP_MODERN_PROTOCOL_VERSION} but the required MCP-Protocol-Version header is absent`;
    return jsonRpcError(
      400,
      HEADER_MISMATCH_ERROR_CODE,
      `Bad Request: the request headers and body disagree: ${body}`,
      { mismatch: { header: "(missing)", body } }
    );
  }
  return undefined;
}

/**
 * Sessionless per-request serving for 2026-07-28 clients.
 *
 * Strictly modern (`legacy: "reject"`): every 2025-era request is routed to
 * the stateful session transport before this handler is reached, so a legacy
 * `initialize` can never negotiate a 2026 era here. The factory builds one
 * surface per request from the shared runtime context, so profile, write
 * gate, and egress context are the same objects the session path uses.
 */
export function createModernMcpHandler(
  context: ToolContext,
  createServer: (context: ToolContext) => McpServer
): ModernMcpHandler {
  const handler = createMcpHandler(() => createServer(context), {
    legacy: "reject",
  });
  return {
    fetch: (request, parsedBody) => handler.fetch(request, { parsedBody }),
    close: () => handler.close(),
  };
}
