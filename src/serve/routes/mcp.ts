/** Test-only route adapter for the not-yet-secured resident MCP endpoint. */

import type { HttpMcpTransport } from "../../mcp/http-transport";

export interface McpRouteServerControl {
  timeout(request: Request, seconds: number): void;
}

export interface McpHttpRouteHandlers {
  DELETE(request: Request, server?: McpRouteServerControl): Promise<Response>;
  GET(request: Request, server?: McpRouteServerControl): Promise<Response>;
  POST(request: Request, server?: McpRouteServerControl): Promise<Response>;
}

/**
 * Build Bun route handlers without mounting them. Security task 3 owns the
 * production mount; tests inject this object explicitly through startServer.
 */
export function createTestOnlyMcpRoute(
  transport: HttpMcpTransport
): McpHttpRouteHandlers {
  const handle = (
    request: Request,
    server?: McpRouteServerControl
  ): Promise<Response> => {
    // MCP POST responses and GET streams may both be long-lived SSE responses.
    server?.timeout(request, 0);
    return transport.handleRequest(request);
  };
  return { DELETE: handle, GET: handle, POST: handle };
}
