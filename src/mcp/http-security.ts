/** Fail-closed network boundary for the resident Streamable HTTP transport. */

// node:fs/promises exposes atomic create modes and POSIX metadata; Bun.file does not.
import { lstat, open } from "node:fs/promises";

import type { HttpGatewayConfig } from "../config/types";
import type { DestinationClassification } from "../core/destination-classifier";
import type {
  RequestPrincipal,
  RequestSubject,
  RequestSubjectContext,
} from "./context";

import { expandPath } from "../config/paths";
import {
  classifyBindDestination,
  classifyDestination,
} from "../core/destination-classifier";
import { DEFAULT_MCP_TOOL_PROFILE, type McpToolProfile } from "./tool-profile";

export const DEFAULT_HTTP_GATEWAY_HOST = "127.0.0.1";
export const DEFAULT_HTTP_GATEWAY_PORT = 3000;
export const DEFAULT_HTTP_MCP_MAX_BODY_BYTES = 1024 * 1024;
export const DEFAULT_HTTP_MCP_MAX_REQUESTS_PER_MINUTE = 120;
export const DEFAULT_HTTP_MCP_MAX_CONCURRENT_REQUESTS = 64;
export const DEFAULT_HTTP_MCP_MAX_QUEUED_REQUESTS = 16;
export const DEFAULT_HTTP_MCP_MAX_SESSIONS = 32;
export const DEFAULT_HTTP_MCP_SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

const MAX_RATE_KEYS = 4096;
const RATE_WINDOW_MS = 60_000;
const TOKEN_BYTES = 32;
const TOKEN_FILE_FORBIDDEN_MODE = 0o077;
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;

/** Request headers only a `mayAssertSubject` principal may send. */
export const GNO_SUBJECT_HEADER = "gno-subject";
export const GNO_CONTEXT_HEADER = "gno-context";
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const SUBJECT_CONTEXTS: readonly RequestSubjectContext[] = [
  "1to1",
  "shared",
  "public_only",
];

export interface HttpMcpPeerServer {
  requestIP(request: Request): { address: string; port: number } | null;
  timeout(request: Request, seconds: number): void;
}

export interface ResolvedHttpGatewayPrincipal {
  name: string;
  tokenFile: string;
  mayAssertSubject: boolean;
  admin: boolean;
}

export interface ResolvedHttpGatewayConfig {
  host: string;
  port: number;
  tokenFile?: string;
  /** Named bearer tokens; absent unless `gateway.principals` is set. */
  principals?: readonly ResolvedHttpGatewayPrincipal[];
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
  enableWrite: boolean;
  toolProfile: McpToolProfile;
  limits: {
    maxBodyBytes: number;
    maxRequestsPerMinute: number;
    maxConcurrentRequests: number;
    maxQueuedRequests: number;
    maxSessions: number;
    sessionIdleTimeoutMs: number;
  };
}

export interface HttpGatewayOverrides {
  host?: string;
  port?: number;
  tokenFile?: string;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  enableWrite?: boolean;
  toolProfile?: McpToolProfile;
}

export interface AuthorizedHttpMcpRequest {
  authenticated: boolean;
  identity: string;
  /** Matched named principal; absent for the plain token and loopback. */
  principal?: RequestPrincipal;
  /** Subject read from `GNO-Subject` / `GNO-Context` (asserting principals only). */
  subject?: RequestSubject;
  peerClassification: DestinationClassification;
  parsedBody?: unknown;
  request: Request;
}

export type HttpMcpAuthorizationResult =
  | { ok: true; value: AuthorizedHttpMcpRequest }
  | { ok: false; response: Response };

interface TokenState {
  digest: string;
  revision: string;
}

interface RateState {
  count: number;
  windowStartedAt: number;
}

export interface HttpMcpSecurityOptions {
  now?: () => number;
  onCredentialsChanged?: () => Promise<void> | void;
}

function securityError(status: 401 | 403 | 413 | 429 | 503): Response {
  const messages = {
    401: "Unauthorized",
    403: "Forbidden",
    413: "Request body too large",
    429: "Too many requests",
    503: "Resident runtime unavailable",
  } as const;
  const headers = status === 401 ? { "WWW-Authenticate": "Bearer" } : undefined;
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32_000, message: messages[status] },
      id: null,
    },
    { status, headers }
  );
}

export function isHttpGatewayLoopbackBind(host: string): boolean {
  return classifyBindDestination(host).zone === "loopback";
}

function defaultAllowedHosts(host: string, port: number): string[] {
  if (!isHttpGatewayLoopbackBind(host)) return [];
  const normalized =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const rawAuthority = normalized.includes(":")
    ? `[${normalized}]:${port}`
    : `${normalized}:${port}`;
  const authority = new URL(`http://${rawAuthority}`).host;
  return normalized === "127.0.0.1"
    ? [authority, `localhost:${port}`]
    : [authority];
}

function defaultAllowedOrigins(host: string, port: number): string[] {
  return defaultAllowedHosts(host, port).map(
    (allowedHost) => `http://${allowedHost}`
  );
}

function validateHostEntry(host: string): boolean {
  if (host !== host.trim() || host.length === 0) return false;
  if (host.includes("*") || host.includes(",")) return false;
  try {
    const url = new URL(`http://${host}`);
    return (
      url.host.toLowerCase() === host.toLowerCase() && url.pathname === "/"
    );
  } catch {
    return false;
  }
}

function validateOriginEntry(origin: string): boolean {
  if (origin !== origin.trim() || origin.length === 0) return false;
  if (origin.includes("*")) return false;
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.origin === origin
    );
  } catch {
    return false;
  }
}

export function resolveHttpGatewayConfig(
  config: HttpGatewayConfig | undefined,
  overrides: HttpGatewayOverrides = {}
): ResolvedHttpGatewayConfig {
  const host = overrides.host ?? config?.host ?? DEFAULT_HTTP_GATEWAY_HOST;
  const port = overrides.port ?? DEFAULT_HTTP_GATEWAY_PORT;
  return {
    host,
    port,
    tokenFile: overrides.tokenFile ?? config?.tokenFile,
    allowedHosts:
      overrides.allowedHosts ??
      config?.allowedHosts ??
      defaultAllowedHosts(host, port),
    allowedOrigins:
      overrides.allowedOrigins ??
      config?.allowedOrigins ??
      defaultAllowedOrigins(host, port),
    enableWrite: overrides.enableWrite ?? config?.enableWrite ?? false,
    ...(config?.principals?.length
      ? {
          principals: config.principals.map((principal) => ({
            name: principal.name,
            tokenFile: principal.tokenFile,
            mayAssertSubject: principal.mayAssertSubject ?? false,
            admin: principal.admin ?? false,
          })),
        }
      : {}),
    toolProfile:
      overrides.toolProfile ?? config?.toolProfile ?? DEFAULT_MCP_TOOL_PROFILE,
    limits: {
      maxBodyBytes:
        config?.limits?.maxBodyBytes ?? DEFAULT_HTTP_MCP_MAX_BODY_BYTES,
      maxRequestsPerMinute:
        config?.limits?.maxRequestsPerMinute ??
        DEFAULT_HTTP_MCP_MAX_REQUESTS_PER_MINUTE,
      maxConcurrentRequests:
        config?.limits?.maxConcurrentRequests ??
        DEFAULT_HTTP_MCP_MAX_CONCURRENT_REQUESTS,
      maxQueuedRequests:
        config?.limits?.maxQueuedRequests ??
        DEFAULT_HTTP_MCP_MAX_QUEUED_REQUESTS,
      maxSessions: config?.limits?.maxSessions ?? DEFAULT_HTTP_MCP_MAX_SESSIONS,
      sessionIdleTimeoutMs:
        config?.limits?.sessionIdleTimeoutMs ??
        DEFAULT_HTTP_MCP_SESSION_IDLE_TIMEOUT_MS,
    },
  };
}

/** SHA-256 hex of an asserted subject; what request receipts store. */
export function hashGatewaySubject(subject: string): string {
  return new Bun.CryptoHasher("sha256").update(subject).digest("hex");
}

/**
 * Read the subject headers. Only a `mayAssertSubject` principal may send them;
 * anyone else, a malformed value, or a context without a subject is refused.
 */
function readSubjectAssertion(
  headers: Headers,
  principal: RequestPrincipal | undefined
): { ok: true; subject?: RequestSubject } | { ok: false } {
  const id = headers.get(GNO_SUBJECT_HEADER);
  const context = headers.get(GNO_CONTEXT_HEADER);
  if (id === null && context === null) return { ok: true };
  if (!principal?.mayAssertSubject || id === null || !SUBJECT_PATTERN.test(id))
    return { ok: false };
  if (
    context !== null &&
    !SUBJECT_CONTEXTS.includes(context as RequestSubjectContext)
  )
    return { ok: false };
  return {
    ok: true,
    subject: {
      id,
      ...(context === null
        ? {}
        : { context: context as RequestSubjectContext }),
      hash: hashGatewaySubject(id),
    },
  };
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function createTokenFile(path: string): Promise<void> {
  const token = [...crypto.getRandomValues(new Uint8Array(TOKEN_BYTES))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${token}\n`, { encoding: "utf8" });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "EEXIST") throw error;
  } finally {
    await handle?.close();
  }
}

async function loadTokenFile(path: string): Promise<TokenState> {
  const expandedPath = expandPath(path);
  const pathMetadata = await lstat(expandedPath);
  if (!pathMetadata.isFile()) throw new Error("MCP token path must be a file");
  const handle = await open(expandedPath, "r");
  let metadata: Awaited<ReturnType<typeof handle.stat>>;
  let raw: string;
  try {
    metadata = await handle.stat();
    if (
      metadata.dev !== pathMetadata.dev ||
      metadata.ino !== pathMetadata.ino ||
      !metadata.isFile()
    )
      throw new Error("MCP token file changed while opening");
    if (
      process.platform !== "win32" &&
      (metadata.mode & TOKEN_FILE_FORBIDDEN_MODE) !== 0
    )
      throw new Error("MCP token file permissions must be 0600 or stricter");
    raw = await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
  const token = raw.trim();
  if (token.length < 32 || token.length > 512 || !VISIBLE_ASCII.test(token))
    throw new Error("MCP token file contains an invalid token");
  const digest = await sha256(token);
  return {
    digest,
    revision: `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${digest}`,
  };
}

/** Create the explicitly requested token file, then validate restrictive mode. */
export async function ensureHttpMcpTokenFile(path: string): Promise<void> {
  const expandedPath = expandPath(path);
  await createTokenFile(expandedPath);
  await loadTokenFile(expandedPath);
}

async function readBoundedJson(
  request: Request,
  maxBytes: number
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength))
      return { ok: false, response: securityError(413) };
    if (Number(declaredLength) > maxBytes)
      return { ok: false, response: securityError(413) };
  }

  const reader = request.body?.getReader();
  if (!reader) return { ok: true, value: undefined };
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { ok: false, response: securityError(413) };
    }
    chunks.push(result.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(body)) };
  } catch {
    return {
      ok: false,
      response: Response.json(
        {
          jsonrpc: "2.0",
          error: { code: -32_700, message: "Parse error: Invalid JSON" },
          id: null,
        },
        { status: 400 }
      ),
    };
  }
}

export class HttpMcpSecurity {
  readonly #config: ResolvedHttpGatewayConfig;
  readonly #now: () => number;
  readonly #onCredentialsChanged: () => Promise<void> | void;
  readonly #rates = new Map<string, RateState>();
  readonly #principalStates = new Map<string, TokenState>();
  #tokenState?: TokenState;

  constructor(
    config: ResolvedHttpGatewayConfig,
    options: HttpMcpSecurityOptions = {}
  ) {
    this.#config = config;
    this.#now = options.now ?? Date.now;
    this.#onCredentialsChanged = options.onCredentialsChanged ?? (() => {});
  }

  get config(): ResolvedHttpGatewayConfig {
    return this.#config;
  }

  async initialize(): Promise<void> {
    if (!this.#config.allowedHosts.every(validateHostEntry))
      throw new Error("MCP allowedHosts must contain exact Host values");
    if (!this.#config.allowedOrigins.every(validateOriginEntry))
      throw new Error("MCP allowedOrigins must contain exact HTTP(S) origins");

    const loopback = isHttpGatewayLoopbackBind(this.#config.host);
    if (
      !loopback &&
      ((!this.#config.tokenFile && !this.#config.principals) ||
        this.#config.allowedHosts.length === 0 ||
        this.#config.allowedOrigins.length === 0)
    ) {
      throw new Error(
        "Wildcard/non-loopback MCP binding requires tokenFile plus exact allowedHosts and allowedOrigins"
      );
    }

    if (this.#config.tokenFile) {
      await ensureHttpMcpTokenFile(this.#config.tokenFile);
      this.#tokenState = await loadTokenFile(this.#config.tokenFile);
    }

    if (this.#config.principals) {
      const digests = new Set<string>();
      if (this.#tokenState) digests.add(this.#tokenState.digest);
      for (const principal of this.#config.principals) {
        await ensureHttpMcpTokenFile(principal.tokenFile);
        const state = await loadTokenFile(principal.tokenFile);
        if (digests.has(state.digest))
          throw new Error("MCP principals must each use a distinct token");
        digests.add(state.digest);
        this.#principalStates.set(principal.name, state);
      }
    }
  }

  async authorize(
    request: Request,
    server: HttpMcpPeerServer
  ): Promise<HttpMcpAuthorizationResult> {
    const peer = server.requestIP(request);
    if (!peer) return { ok: false, response: securityError(403) };
    const peerClassification = classifyDestination({
      kind: "network",
      hostname: peer.address,
    });
    if (
      isHttpGatewayLoopbackBind(this.#config.host) &&
      peerClassification.zone !== "loopback"
    )
      return { ok: false, response: securityError(403) };

    const host = request.headers.get("host");
    if (
      !host ||
      !this.#config.allowedHosts.some(
        (allowedHost) => allowedHost.toLowerCase() === host.toLowerCase()
      )
    )
      return { ok: false, response: securityError(403) };

    const origin = request.headers.get("origin");
    if (origin && !this.#config.allowedOrigins.includes(origin))
      return { ok: false, response: securityError(403) };

    if (!this.#allowRate(peer.address))
      return { ok: false, response: securityError(429) };

    const requiresAuth =
      !isHttpGatewayLoopbackBind(this.#config.host) ||
      this.#config.tokenFile !== undefined ||
      this.#config.principals !== undefined;
    const tokenState = await this.#refreshTokenState();
    const principalStates = await this.#refreshPrincipalStates();
    let identity = "loopback";
    let authenticated = false;
    let principal: RequestPrincipal | undefined;
    if (requiresAuth) {
      if (!tokenState && principalStates.length === 0)
        return { ok: false, response: securityError(503) };
      const authorization = request.headers.get("authorization");
      const match = authorization?.match(/^Bearer ([\x21-\x7e]+)$/);
      if (!match) return { ok: false, response: securityError(401) };
      const presentedDigest = await sha256(match[1] ?? "");
      if (tokenState && constantTimeEqual(presentedDigest, tokenState.digest)) {
        identity = tokenState.digest;
      } else {
        const matched = principalStates.find(({ state }) =>
          constantTimeEqual(presentedDigest, state.digest)
        );
        if (!matched) return { ok: false, response: securityError(401) };
        identity = matched.state.digest;
        principal = {
          name: matched.principal.name,
          admin: matched.principal.admin,
          mayAssertSubject: matched.principal.mayAssertSubject,
        };
      }
      authenticated = true;
    }

    // Without configured principals the subject headers mean nothing and are
    // only stripped, so existing callers see no change.
    let subject: RequestSubject | undefined;
    if (this.#config.principals) {
      const assertion = readSubjectAssertion(request.headers, principal);
      if (!assertion.ok) return { ok: false, response: securityError(403) };
      subject = assertion.subject;
    }

    let parsedBody: unknown;
    if (request.method === "POST") {
      const body = await readBoundedJson(
        request,
        this.#config.limits.maxBodyBytes
      );
      if (!body.ok) return body;
      parsedBody = body.value;
    }

    const sanitizedHeaders = new Headers(request.headers);
    sanitizedHeaders.delete("authorization");
    sanitizedHeaders.delete("forwarded");
    sanitizedHeaders.delete("content-length");
    sanitizedHeaders.delete("transfer-encoding");
    sanitizedHeaders.delete(GNO_SUBJECT_HEADER);
    sanitizedHeaders.delete(GNO_CONTEXT_HEADER);
    const forwardedHeaderNames: string[] = [];
    for (const name of sanitizedHeaders.keys())
      if (name.startsWith("x-forwarded-")) forwardedHeaderNames.push(name);
    for (const name of forwardedHeaderNames) sanitizedHeaders.delete(name);
    const sanitizedRequest = new Request(request.url, {
      method: request.method,
      headers: sanitizedHeaders,
      signal: request.signal,
    });

    return {
      ok: true,
      value: {
        authenticated,
        identity,
        ...(principal ? { principal } : {}),
        ...(subject ? { subject } : {}),
        peerClassification,
        parsedBody,
        request: sanitizedRequest,
      },
    };
  }

  #allowRate(key: string): boolean {
    const now = this.#now();
    let state = this.#rates.get(key);
    if (!state || now - state.windowStartedAt >= RATE_WINDOW_MS) {
      state = { count: 0, windowStartedAt: now };
      this.#rates.set(key, state);
    }
    state.count += 1;
    if (this.#rates.size > MAX_RATE_KEYS) {
      for (const [rateKey, candidate] of this.#rates) {
        if (now - candidate.windowStartedAt >= RATE_WINDOW_MS)
          this.#rates.delete(rateKey);
      }
      if (this.#rates.size > MAX_RATE_KEYS) this.#rates.clear();
    }
    return state.count <= this.#config.limits.maxRequestsPerMinute;
  }

  /** Reload every principal token; a broken file disables only that principal. */
  async #refreshPrincipalStates(): Promise<
    Array<{ principal: ResolvedHttpGatewayPrincipal; state: TokenState }>
  > {
    const principals = this.#config.principals ?? [];
    const active: Array<{
      principal: ResolvedHttpGatewayPrincipal;
      state: TokenState;
    }> = [];
    let changed = false;
    for (const principal of principals) {
      const previous = this.#principalStates.get(principal.name);
      let next: TokenState | undefined;
      try {
        next = await loadTokenFile(principal.tokenFile);
      } catch {
        next = undefined;
      }
      if (previous && previous.revision !== next?.revision) changed = true;
      if (next) {
        this.#principalStates.set(principal.name, next);
        active.push({ principal, state: next });
      } else {
        this.#principalStates.delete(principal.name);
      }
    }
    if (changed) await this.#onCredentialsChanged();
    // Two principals sharing a token after rotation would be ambiguous: refuse both.
    const counts = new Map<string, number>();
    for (const { state } of active)
      counts.set(state.digest, (counts.get(state.digest) ?? 0) + 1);
    if (this.#tokenState)
      counts.set(
        this.#tokenState.digest,
        (counts.get(this.#tokenState.digest) ?? 0) + 1
      );
    return active.filter(({ state }) => counts.get(state.digest) === 1);
  }

  async #refreshTokenState(): Promise<TokenState | undefined> {
    if (!this.#config.tokenFile) return undefined;
    let next: TokenState | undefined;
    try {
      next = await loadTokenFile(this.#config.tokenFile);
    } catch {
      if (this.#tokenState) {
        this.#tokenState = undefined;
        await this.#onCredentialsChanged();
      }
      return undefined;
    }
    if (this.#tokenState && this.#tokenState.revision !== next.revision)
      await this.#onCredentialsChanged();
    this.#tokenState = next;
    return next;
  }
}
