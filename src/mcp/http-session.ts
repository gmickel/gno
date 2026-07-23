/** Isolated stateful MCP server/transport ownership for HTTP sessions. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import type { ToolContext } from "./context";

import { MCP_SERVER_NAME, VERSION } from "../app/constants";
import { createMcpServerSurface } from "./context";

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 32;
const MAX_REAP_INTERVAL_MS = 30_000;

export interface HttpMcpSessionRuntime {
  readonly mcpContext: ToolContext;
  openSession(): () => void;
}

export interface HttpMcpSession {
  readonly id: string;
  readonly securityIdentity: string;
  readonly server: McpServer;
  readonly transport: WebStandardStreamableHTTPServerTransport;
  lastActivityAt: number;
  activeRequests: number;
}

export interface HttpMcpSessionStoreOptions {
  idleTimeoutMs?: number;
  maxSessions?: number;
  now?: () => number;
  sessionIdGenerator?: () => string;
  createServer?: (context: ToolContext) => McpServer;
}

export interface PendingHttpMcpSession {
  readonly server: McpServer;
  readonly transport: WebStandardStreamableHTTPServerTransport;
  get session(): HttpMcpSession | undefined;
  discard(): Promise<void>;
}

interface OwnedHttpMcpSession extends HttpMcpSession {
  releaseRuntimeSession(): void;
}

interface PendingSessionHost {
  readonly server: McpServer;
  readonly transport: WebStandardStreamableHTTPServerTransport;
  session?: OwnedHttpMcpSession;
  discarded: boolean;
}

function isVisibleAscii(value: string): boolean {
  if (value.length === 0) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

/** Owns exactly one McpServer and Web Standard transport per active session. */
export class HttpMcpSessionStore {
  readonly #runtime: HttpMcpSessionRuntime;
  readonly #idleTimeoutMs: number;
  readonly #maxSessions: number;
  readonly #now: () => number;
  readonly #sessionIdGenerator: () => string;
  readonly #createServer: (context: ToolContext) => McpServer;
  readonly #sessions = new Map<string, OwnedHttpMcpSession>();
  readonly #pending = new Set<PendingSessionHost>();
  readonly #reapTimer: ReturnType<typeof setInterval>;
  #closed = false;

  constructor(
    runtime: HttpMcpSessionRuntime,
    options: HttpMcpSessionStoreOptions = {}
  ) {
    this.#runtime = runtime;
    this.#idleTimeoutMs = Math.max(
      1,
      options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    );
    this.#maxSessions = Math.max(
      1,
      Math.floor(options.maxSessions ?? DEFAULT_MAX_SESSIONS)
    );
    this.#now = options.now ?? Date.now;
    this.#sessionIdGenerator =
      options.sessionIdGenerator ?? (() => crypto.randomUUID());
    this.#createServer =
      options.createServer ??
      ((context) =>
        createMcpServerSurface(context, {
          name: MCP_SERVER_NAME,
          version: VERSION,
        }));

    this.#reapTimer = setInterval(
      () => void this.reapIdleSessions(),
      Math.min(this.#idleTimeoutMs, MAX_REAP_INTERVAL_MS)
    );
    this.#reapTimer.unref?.();
  }

  get size(): number {
    return this.#sessions.size;
  }

  get maxSessions(): number {
    return this.#maxSessions;
  }

  get capacityAvailable(): boolean {
    return (
      !this.#closed &&
      this.#sessions.size + this.#pending.size < this.#maxSessions
    );
  }

  get(sessionId: string): HttpMcpSession | undefined {
    return this.#sessions.get(sessionId);
  }

  beginRequest(session: HttpMcpSession): void {
    session.activeRequests += 1;
    session.lastActivityAt = this.#now();
  }

  finishRequest(session: HttpMcpSession): void {
    session.activeRequests = Math.max(0, session.activeRequests - 1);
    session.lastActivityAt = this.#now();
  }

  async createPendingSession(
    securityIdentity = "loopback"
  ): Promise<PendingHttpMcpSession | null> {
    if (!this.capacityAvailable) return null;

    const server = this.#createServer(this.#runtime.mcpContext);
    let host: PendingSessionHost;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => {
        const sessionId = this.#sessionIdGenerator();
        if (!isVisibleAscii(sessionId)) {
          throw new Error(
            "MCP session ID must contain visible ASCII characters"
          );
        }
        return sessionId;
      },
      // Intentionally no EventStore: this release does not support resumption.
      onsessioninitialized: (sessionId) => {
        if (host.discarded || this.#closed) {
          throw new Error("MCP session store is closed");
        }
        if (this.#sessions.has(sessionId)) {
          throw new Error("MCP session ID collision");
        }
        const releaseRuntimeSession = this.#runtime.openSession();
        host.session = {
          id: sessionId,
          securityIdentity,
          server,
          transport,
          lastActivityAt: this.#now(),
          activeRequests: 0,
          releaseRuntimeSession,
        };
        this.#sessions.set(sessionId, host.session);
        this.#pending.delete(host);
      },
    });
    host = { server, transport, discarded: false };
    this.#pending.add(host);

    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId) this.#releaseSession(sessionId);
      this.#pending.delete(host);
    };

    try {
      await server.connect(transport);
    } catch (error) {
      this.#pending.delete(host);
      host.discarded = true;
      await server.close().catch(() => undefined);
      throw error;
    }

    return {
      server,
      transport,
      get session() {
        return host.session;
      },
      discard: async () => {
        if (host.session || host.discarded) return;
        host.discarded = true;
        this.#pending.delete(host);
        await server.close().catch(() => undefined);
      },
    };
  }

  async closeSession(sessionId: string): Promise<boolean> {
    const session = this.#releaseSession(sessionId);
    if (!session) return false;
    await session.server.close().catch(() => undefined);
    return true;
  }

  async reapIdleSessions(now = this.#now()): Promise<number> {
    const staleSessionIds = [...this.#sessions.values()]
      .filter(
        (session) =>
          session.activeRequests === 0 &&
          now - session.lastActivityAt >= this.#idleTimeoutMs
      )
      .map((session) => session.id);
    await Promise.allSettled(
      staleSessionIds.map((sessionId) => this.closeSession(sessionId))
    );
    return staleSessionIds.length;
  }

  async closeAll(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#reapTimer);

    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    for (const session of sessions) session.releaseRuntimeSession();

    const pending = [...this.#pending];
    this.#pending.clear();
    for (const host of pending) host.discarded = true;

    await Promise.allSettled([
      ...sessions.map((session) => session.server.close()),
      ...pending.map((host) => host.server.close()),
    ]);
  }

  async closeSessions(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    for (const session of sessions) session.releaseRuntimeSession();

    const pending = [...this.#pending];
    this.#pending.clear();
    for (const host of pending) host.discarded = true;

    await Promise.allSettled([
      ...sessions.map((session) => session.server.close()),
      ...pending.map((host) => host.server.close()),
    ]);
  }

  #releaseSession(sessionId: string): OwnedHttpMcpSession | undefined {
    const session = this.#sessions.get(sessionId);
    if (!session) return undefined;
    this.#sessions.delete(sessionId);
    session.releaseRuntimeSession();
    return session;
  }
}
