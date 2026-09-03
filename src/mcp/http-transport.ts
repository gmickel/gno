/** Web Standard Streamable HTTP request routing for the resident MCP runtime. */

import {
  isInitializeRequest,
  type McpServer,
} from "@modelcontextprotocol/server";

import type { DestinationClassification } from "../core/destination-classifier";
import type { ResidentRequestHandle } from "../serve/resident-runtime";
import type {
  HttpMcpSession,
  HttpMcpSessionRuntime,
  HttpMcpSessionStoreOptions,
  PendingHttpMcpSession,
} from "./http-session";

import { MCP_SERVER_NAME, VERSION } from "../app/constants";
import { EgressDeniedError } from "../core/egress-enforcement";
import { createMcpServerSurface, type ToolContext } from "./context";
import {
  enforceHttpMcpEgress,
  httpMcpEgressDeniedResponse,
} from "./http-egress";
import {
  createModernMcpHandler,
  isModernMcpRequest,
  type ModernMcpHandler,
  rejectMalformedModernRequest,
  rejectUnsupportedModernStream,
} from "./http-modern";
import { HttpMcpSessionStore } from "./http-session";
import { MCP_WRITE_TOOL_NAMES } from "./tools/index";

const DEFAULT_MAX_CONCURRENT_REQUESTS = 64;
const DEFAULT_MAX_QUEUED_REQUESTS = 0;
const MCP_HTTP_METHODS = new Set(["DELETE", "GET", "POST"]);
const MCP_SESSION_HEADER = "mcp-session-id";
const REQUEST_IDENTITY_DIGEST_LENGTH = 16;
const POLICY_CHANGED_SSE = new TextEncoder().encode(
  'event: message\ndata: {"jsonrpc":"2.0","error":{"code":-32000,"message":"EGRESS_POLICY_CHANGED: Collection policy changed; retry"},"id":null}\n\n'
);

export interface HttpMcpTransportRuntime extends HttpMcpSessionRuntime {
  readonly authorizationEpoch?: string;
  readonly isShuttingDown: boolean;
  admitRequest(signal?: AbortSignal): ResidentRequestHandle | null;
}

export interface HttpMcpTransportOptions extends HttpMcpSessionStoreOptions {
  maxConcurrentRequests?: number;
  maxQueuedRequests?: number;
  enableWrite?: boolean;
}

export interface HttpMcpRequestContext {
  authenticated?: boolean;
  identity: string;
  parsedBody?: unknown;
  peerClassification?: DestinationClassification;
}

export interface HttpMcpTransportStatus {
  activeRequests: number;
  activeSessions: number;
  queuedRequests: number;
  maxConcurrentRequests: number;
  maxQueuedRequests: number;
  maxSessions: number;
}

function jsonRpcError(
  status: number,
  code: number,
  message: string,
  headers?: HeadersInit
): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code, message }, id: null },
    { status, headers }
  );
}

function methodNotAllowed(): Response {
  return jsonRpcError(405, -32_000, "Method not allowed.", {
    Allow: "GET, POST, DELETE",
  });
}

function containsUnauthorizedWrite(parsedBody: unknown): boolean {
  const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
  return messages.some((message) => {
    if (typeof message !== "object" || message === null) return false;
    const candidate = message as {
      method?: unknown;
      params?: { name?: unknown };
    };
    return (
      candidate.method === "tools/call" &&
      typeof candidate.params?.name === "string" &&
      MCP_WRITE_TOOL_NAMES.has(candidate.params.name)
    );
  });
}

function validateInitializeHeaders(request: Request): Response | undefined {
  const accept = request.headers.get("accept");
  if (
    !accept?.includes("application/json") ||
    !accept.includes("text/event-stream")
  ) {
    return jsonRpcError(
      406,
      -32_000,
      "Not Acceptable: Client must accept both application/json and text/event-stream"
    );
  }
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return jsonRpcError(
      415,
      -32_000,
      "Unsupported Media Type: Content-Type must be application/json"
    );
  }
  return undefined;
}

function wrapStreamingResponse(
  response: Response,
  finish: () => void,
  isAuthorizationEpochCurrent: () => boolean
): Response {
  if (!response.body) {
    finish();
    return response;
  }
  const reader = response.body.getReader();
  let finished = false;
  const finishOnce = (): void => {
    if (finished) return;
    finished = true;
    finish();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!isAuthorizationEpochCurrent()) {
          await reader.cancel("EGRESS_POLICY_CHANGED");
          controller.enqueue(POLICY_CHANGED_SSE);
          controller.close();
          finishOnce();
          return;
        }
        const result = await reader.read();
        if (!isAuthorizationEpochCurrent()) {
          await reader.cancel("EGRESS_POLICY_CHANGED");
          controller.enqueue(POLICY_CHANGED_SSE);
          controller.close();
          finishOnce();
          return;
        }
        if (result.done) {
          controller.close();
          finishOnce();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
        finishOnce();
      }
    },
    async cancel(reason) {
      finishOnce();
      await reader.cancel(reason);
    },
  });
  return new Response(body, response);
}

/**
 * Opaque per-caller label for memory provenance and other per-session state.
 *
 * The security identity is a bearer digest or `loopback`; hashing it with the
 * server instance id yields a label that is stable for one caller within one
 * server lifetime, differs between callers, and never reveals the digest in a
 * stored record.
 */
function deriveRequestIdentity(
  serverInstanceId: string,
  securityIdentity: string
): string {
  const digest = new Bun.CryptoHasher("sha256")
    .update(`${serverInstanceId}\u0000${securityIdentity}`)
    .digest("hex")
    .slice(0, REQUEST_IDENTITY_DIGEST_LENGTH);
  return `http:${digest}`;
}

const policyChangedResponse = (): Response =>
  jsonRpcError(
    409,
    -32_000,
    "EGRESS_POLICY_CHANGED: Collection policy changed; retry"
  );

const defaultCreateServer = (context: ToolContext): McpServer =>
  createMcpServerSurface(context, { name: MCP_SERVER_NAME, version: VERSION });

/**
 * Dual-era gateway used by the production `/mcp` route.
 *
 * 2025-era traffic (initialize handshake, `Mcp-Session-Id`) is served by the
 * stateful session store; 2026-07-28 traffic (per-request `_meta` envelope)
 * is served sessionless. Every guard below the method check - capacity,
 * admission, write gate, egress, authorization epoch, metrics - runs before
 * the era branch, so both legs share one enforcement path.
 */
export class HttpMcpTransport {
  readonly #runtime: HttpMcpTransportRuntime;
  readonly #sessions: HttpMcpSessionStore;
  readonly #modern: ModernMcpHandler;
  readonly #maxConcurrentRequests: number;
  readonly #maxQueuedRequests: number;
  readonly #enableWrite: boolean;
  readonly #capacityWaiters: Array<(admitted: boolean) => void> = [];
  #activeRequests = 0;
  #closed = false;

  constructor(
    runtime: HttpMcpTransportRuntime,
    options: HttpMcpTransportOptions = {}
  ) {
    this.#runtime = runtime;
    const createServer = options.createServer ?? defaultCreateServer;
    this.#sessions = new HttpMcpSessionStore(runtime, {
      ...options,
      createServer,
    });
    this.#modern = createModernMcpHandler(runtime.mcpContext, createServer);
    this.#maxConcurrentRequests = Math.max(
      1,
      Math.floor(
        options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS
      )
    );
    this.#maxQueuedRequests = Math.max(
      0,
      Math.floor(options.maxQueuedRequests ?? DEFAULT_MAX_QUEUED_REQUESTS)
    );
    this.#enableWrite = options.enableWrite ?? false;
  }

  get activeRequests(): number {
    return this.#activeRequests;
  }

  get activeSessions(): number {
    return this.#sessions.size;
  }

  get queuedRequests(): number {
    return this.#capacityWaiters.length;
  }

  getStatus(): HttpMcpTransportStatus {
    return {
      activeRequests: this.activeRequests,
      activeSessions: this.activeSessions,
      queuedRequests: this.queuedRequests,
      maxConcurrentRequests: this.#maxConcurrentRequests,
      maxQueuedRequests: this.#maxQueuedRequests,
      maxSessions: this.#sessions.maxSessions,
    };
  }

  async handleRequest(
    request: Request,
    context: HttpMcpRequestContext = { identity: "loopback" }
  ): Promise<Response> {
    if (!MCP_HTTP_METHODS.has(request.method)) return methodNotAllowed();
    if (this.#closed || this.#runtime.isShuttingDown)
      return jsonRpcError(503, -32_000, "Resident runtime is unavailable");
    if (!(await this.#acquireCapacity(request.signal))) {
      if (this.#closed || this.#runtime.isShuttingDown)
        return jsonRpcError(503, -32_000, "Resident runtime is unavailable");
      return jsonRpcError(429, -32_000, "Too many requests");
    }

    const admission = this.#runtime.admitRequest(request.signal);
    if (!admission) {
      this.#releaseCapacity();
      return jsonRpcError(503, -32_000, "Resident runtime is unavailable");
    }

    let session: HttpMcpSession | undefined;
    let pending: PendingHttpMcpSession | undefined;
    let finished = false;
    const authorizationEpoch = {
      value:
        admission.authorizationEpoch ??
        this.#runtime.authorizationEpoch ??
        "egress-epoch-unavailable",
    };
    const isAuthorizationEpochCurrent = (): boolean =>
      this.#runtime.authorizationEpoch === undefined ||
      authorizationEpoch.value === this.#runtime.authorizationEpoch;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      if (session) this.#sessions.finishRequest(session);
      this.#releaseCapacity();
      admission.finish();
    };

    try {
      const sessionId = request.headers.get(MCP_SESSION_HEADER);
      let parsedBody = context.parsedBody;
      if (request.method === "POST" && parsedBody === undefined) {
        try {
          parsedBody = await request.clone().json();
        } catch {
          finish();
          return jsonRpcError(400, -32_700, "Parse error: Invalid JSON");
        }
      }

      const legacy = !(await isModernMcpRequest(request, parsedBody));
      if (!legacy) {
        const rejection =
          rejectMalformedModernRequest(request) ??
          rejectUnsupportedModernStream(parsedBody);
        if (rejection) {
          finish();
          return rejection;
        }
      } else if (sessionId) {
        session = this.#sessions.get(sessionId);
        if (!session) {
          finish();
          return jsonRpcError(404, -32_001, "Session not found");
        }
        if (session.securityIdentity !== context.identity) {
          await this.#sessions.closeSession(sessionId);
          finish();
          return jsonRpcError(403, -32_000, "Forbidden");
        }
        this.#sessions.beginRequest(session);
      } else {
        if (request.method !== "POST") {
          finish();
          return jsonRpcError(
            400,
            -32_000,
            "Bad Request: Mcp-Session-Id header is required"
          );
        }
        const headerError = validateInitializeHeaders(request);
        if (headerError) {
          finish();
          return headerError;
        }
        if (!isInitializeRequest(parsedBody)) {
          finish();
          return jsonRpcError(
            400,
            -32_000,
            "Bad Request: No valid session ID provided"
          );
        }
        pending =
          (await this.#sessions.createPendingSession(context.identity)) ??
          undefined;
        if (!pending) {
          finish();
          return jsonRpcError(429, -32_000, "Too many requests");
        }
      }

      if (request.headers.has("last-event-id")) {
        await pending?.discard();
        finish();
        return jsonRpcError(
          400,
          -32_000,
          "MCP event resumption is not supported"
        );
      }

      const transport = session?.transport ?? pending?.transport;
      if (legacy && !transport)
        throw new Error("MCP transport was not created");
      const requestBody = parsedBody;
      if (!this.#enableWrite && containsUnauthorizedWrite(requestBody)) {
        await pending?.discard();
        finish();
        return jsonRpcError(403, -32_000, "Forbidden");
      }
      try {
        enforceHttpMcpEgress(
          requestBody,
          this.#runtime.mcpContext.collections,
          {
            authenticated: context.authenticated ?? false,
            destinationZone:
              context.peerClassification?.zone ??
              (context.identity === "loopback" ? "loopback" : "remote"),
            operationAuthorized: true,
          }
        );
      } catch (error) {
        if (error instanceof EgressDeniedError) {
          await pending?.discard();
          finish();
          return httpMcpEgressDeniedResponse(error, requestBody);
        }
        throw error;
      }
      const handle = () =>
        transport
          ? transport.handleRequest(
              request,
              requestBody === undefined
                ? undefined
                : { parsedBody: requestBody }
            )
          : this.#modern.fetch(request, requestBody);
      const destinationZone =
        context.peerClassification?.zone ??
        (context.identity === "loopback" ? "loopback" : "remote");
      const response = this.#runtime.mcpContext.runWithEgressContext
        ? await this.#runtime.mcpContext.runWithEgressContext(
            {
              destinationZone,
              caller: {
                authenticated: context.authenticated ?? false,
                operationAuthorized: true,
              },
              authorizationEpoch,
            },
            handle,
            {
              requestIdentity: deriveRequestIdentity(
                this.#runtime.mcpContext.serverInstanceId,
                context.identity
              ),
            }
          )
        : await handle();

      if (!isAuthorizationEpochCurrent()) {
        await pending?.discard();
        finish();
        return policyChangedResponse();
      }

      if (pending) {
        session = pending.session;
        if (!session) await pending.discard();
        else this.#sessions.beginRequest(session);
      }

      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        return wrapStreamingResponse(
          response,
          finish,
          isAuthorizationEpochCurrent
        );
      }
      finish();
      return response;
    } catch {
      await pending?.discard();
      finish();
      return jsonRpcError(500, -32_603, "Internal MCP transport error");
    }
  }

  reapIdleSessions(now?: number): Promise<number> {
    return this.#sessions.reapIdleSessions(now);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const resolve of this.#capacityWaiters.splice(0)) resolve(false);
    await Promise.all([this.#sessions.closeAll(), this.#modern.close()]);
  }

  invalidateAuthenticatedSessions(): Promise<void> {
    return this.#sessions.closeSessions();
  }

  #acquireCapacity(signal: AbortSignal): Promise<boolean> {
    if (this.#closed || this.#runtime.isShuttingDown)
      return Promise.resolve(false);
    if (signal.aborted) return Promise.resolve(false);
    if (this.#activeRequests < this.#maxConcurrentRequests) {
      this.#activeRequests += 1;
      return Promise.resolve(true);
    }
    if (this.#capacityWaiters.length >= this.#maxQueuedRequests)
      return Promise.resolve(false);

    return new Promise((resolve) => {
      const complete = (admitted: boolean): void => {
        signal.removeEventListener("abort", onAbort);
        resolve(admitted);
      };
      const onAbort = (): void => {
        const index = this.#capacityWaiters.indexOf(complete);
        if (index >= 0) this.#capacityWaiters.splice(index, 1);
        complete(false);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#capacityWaiters.push(complete);
    });
  }

  #releaseCapacity(): void {
    this.#activeRequests = Math.max(0, this.#activeRequests - 1);
    const next = this.#capacityWaiters.shift();
    if (!next) return;
    if (this.#closed || this.#runtime.isShuttingDown) {
      next(false);
      return;
    }
    this.#activeRequests += 1;
    next(true);
  }
}
