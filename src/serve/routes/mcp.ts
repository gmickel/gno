/** Production route adapter for the secured resident MCP endpoint. */

import type {
  HttpMcpPeerServer,
  ResolvedHttpGatewayConfig,
} from "../../mcp/http-security";
import type { ResidentRuntime } from "../resident-runtime";

import { HttpMcpSecurity } from "../../mcp/http-security";
import { HttpMcpTransport } from "../../mcp/http-transport";

export type McpHttpRoute = (
  request: Request,
  server: HttpMcpPeerServer
) => Promise<Response>;

export interface McpHttpGateway {
  readonly route: McpHttpRoute;
  readonly security: HttpMcpSecurity;
  readonly transport: HttpMcpTransport;
  close(): Promise<void>;
}

/**
 * Build the route only after startup policy and token-file checks succeed.
 * Every method passes through the external boundary before transport dispatch.
 */
export async function createMcpHttpGateway(
  runtime: ResidentRuntime,
  config: ResolvedHttpGatewayConfig
): Promise<McpHttpGateway> {
  runtime.mcpContext.enableWrite = config.enableWrite;
  runtime.mcpContext.toolProfile = config.toolProfile;
  const transport = new HttpMcpTransport(runtime, {
    enableWrite: config.enableWrite,
    idleTimeoutMs: config.limits.sessionIdleTimeoutMs,
    maxConcurrentRequests: config.limits.maxConcurrentRequests,
    maxQueuedRequests: config.limits.maxQueuedRequests,
    maxSessions: config.limits.maxSessions,
  });
  const security = new HttpMcpSecurity(config, {
    onCredentialsChanged: () => transport.invalidateAuthenticatedSessions(),
  });
  await security.initialize();
  (runtime as Partial<ResidentRuntime>).setTransportStatusProvider?.(() =>
    transport.getStatus()
  );
  (runtime as Partial<ResidentRuntime>).setPolicySessionInvalidator?.(() =>
    transport.invalidateAuthenticatedSessions()
  );

  const route: McpHttpRoute = async (request, server) => {
    const authorization = await security.authorize(request, server);
    if (!authorization.ok) return authorization.response;

    // POST responses and GET streams may both be long-lived SSE responses.
    server.timeout(request, 0);
    return transport.handleRequest(authorization.value.request, {
      authenticated: authorization.value.authenticated,
      identity: authorization.value.identity,
      parsedBody: authorization.value.parsedBody,
      peerClassification: authorization.value.peerClassification,
    });
  };

  return {
    route,
    security,
    transport,
    close: async () => {
      await transport.close();
      (runtime as Partial<ResidentRuntime>).setTransportStatusProvider?.(null);
      (runtime as Partial<ResidentRuntime>).setPolicySessionInvalidator?.(null);
    },
  };
}
