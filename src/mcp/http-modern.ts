/** 2026-07-28 (sessionless) leg of the resident Streamable HTTP transport. */

import {
  createMcpHandler,
  isLegacyRequest,
  type McpServer,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";

import type { ToolContext } from "./context";

export const MCP_MODERN_PROTOCOL_VERSION = "2026-07-28";
const MCP_PROTOCOL_VERSION_HEADER = "mcp-protocol-version";
const MCP_SESSION_HEADER = "mcp-session-id";
/** SEP-2243 `HeaderMismatch`: the standard headers and the body disagree. */
const HEADER_MISMATCH_ERROR_CODE = -32_020;
const INVALID_REQUEST_ERROR_CODE = -32_600;
const SERVER_ERROR_CODE = -32_000;

export interface ModernMcpHandler {
  fetch(request: Request, parsedBody: unknown): Promise<Response>;
  close(): Promise<void>;
}

function jsonRpcError(
  status: number,
  code: number,
  message: string,
  data?: unknown
): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code, message, ...(data === undefined ? {} : { data }) },
      id: null,
    },
    { status }
  );
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
  return header !== null && header >= MCP_MODERN_PROTOCOL_VERSION;
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
  const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
  return messages.some(carriesEnvelopeClaim) || namesModernRevision(request);
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
