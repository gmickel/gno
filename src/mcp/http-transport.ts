/** Web Standard Streamable HTTP request routing for the resident MCP runtime. */

import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import type { ResidentRequestHandle } from "../serve/resident-runtime";
import type {
  HttpMcpSession,
  HttpMcpSessionRuntime,
  HttpMcpSessionStoreOptions,
  PendingHttpMcpSession,
} from "./http-session";

import { HttpMcpSessionStore } from "./http-session";

const DEFAULT_MAX_CONCURRENT_REQUESTS = 64;
const MCP_HTTP_METHODS = new Set(["DELETE", "GET", "POST"]);
const MCP_SESSION_HEADER = "mcp-session-id";

export interface HttpMcpTransportRuntime extends HttpMcpSessionRuntime {
  readonly isShuttingDown: boolean;
  admitRequest(signal?: AbortSignal): ResidentRequestHandle | null;
}

export interface HttpMcpTransportOptions extends HttpMcpSessionStoreOptions {
  maxConcurrentRequests?: number;
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
  finish: () => void
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
        const result = await reader.read();
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

/** Stateful session gateway. The production server does not mount it yet. */
export class HttpMcpTransport {
  readonly #runtime: HttpMcpTransportRuntime;
  readonly #sessions: HttpMcpSessionStore;
  readonly #maxConcurrentRequests: number;
  #activeRequests = 0;

  constructor(
    runtime: HttpMcpTransportRuntime,
    options: HttpMcpTransportOptions = {}
  ) {
    this.#runtime = runtime;
    this.#sessions = new HttpMcpSessionStore(runtime, options);
    this.#maxConcurrentRequests = Math.max(
      1,
      Math.floor(
        options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS
      )
    );
  }

  get activeRequests(): number {
    return this.#activeRequests;
  }

  get activeSessions(): number {
    return this.#sessions.size;
  }

  async handleRequest(request: Request): Promise<Response> {
    if (!MCP_HTTP_METHODS.has(request.method)) return methodNotAllowed();
    if (this.#runtime.isShuttingDown)
      return jsonRpcError(503, -32_000, "Resident runtime is unavailable");
    if (this.#activeRequests >= this.#maxConcurrentRequests)
      return jsonRpcError(429, -32_000, "MCP request capacity exceeded");

    const admission = this.#runtime.admitRequest(request.signal);
    if (!admission)
      return jsonRpcError(503, -32_000, "Resident runtime is unavailable");

    this.#activeRequests += 1;
    let session: HttpMcpSession | undefined;
    let pending: PendingHttpMcpSession | undefined;
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      if (session) this.#sessions.finishRequest(session);
      this.#activeRequests = Math.max(0, this.#activeRequests - 1);
      admission.finish();
    };

    try {
      const sessionId = request.headers.get(MCP_SESSION_HEADER);
      let parsedBody: unknown;

      if (sessionId) {
        session = this.#sessions.get(sessionId);
        if (!session) {
          finish();
          return jsonRpcError(404, -32_001, "Session not found");
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
        try {
          parsedBody = await request.clone().json();
        } catch {
          finish();
          return jsonRpcError(400, -32_700, "Parse error: Invalid JSON");
        }
        if (!isInitializeRequest(parsedBody)) {
          finish();
          return jsonRpcError(
            400,
            -32_000,
            "Bad Request: No valid session ID provided"
          );
        }
        pending = (await this.#sessions.createPendingSession()) ?? undefined;
        if (!pending) {
          finish();
          return jsonRpcError(429, -32_000, "MCP session capacity exceeded");
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
      if (!transport) throw new Error("MCP transport was not created");
      const response = await transport.handleRequest(
        request,
        parsedBody === undefined ? undefined : { parsedBody }
      );

      if (pending) {
        session = pending.session;
        if (!session) await pending.discard();
        else this.#sessions.beginRequest(session);
      }

      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        return wrapStreamingResponse(response, finish);
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

  close(): Promise<void> {
    return this.#sessions.closeAll();
  }
}
