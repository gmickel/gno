/** Security and admission boundary for loopback browser-clipper routes. */

import type { HttpMcpPeerServer } from "../mcp/http-security";

import { readClipperBoundedJson } from "./clipper-body";
import { clipperSecurityErrorResponse } from "./clipper-security-errors";
import { ReaderGate } from "./resident-admission";

export { readClipperBoundedJson } from "./clipper-body";
export { ReaderGate as ClipperRequestGate } from "./resident-admission";
export { clipperSecurityErrorResponse } from "./clipper-security-errors";

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_REQUESTS_PER_MINUTE = 60;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 4;
const DEFAULT_MAX_QUEUED_REQUESTS = 8;
const MAX_RATE_KEYS = 4096;
const RATE_WINDOW_MS = 60_000;
const PREFLIGHT_MAX_AGE_SECONDS = 600;
const CHROME_EXTENSION_ORIGIN =
  /^chrome-extension:\/\/(?<extensionId>[a-p]{32})$/;

export const DEFAULT_CLIPPER_ALLOWED_HEADERS = [
  "authorization",
  "content-type",
  "idempotency-key",
] as const;

export interface ClipperSecurityLimits {
  maxBodyBytes: number;
  maxRequestsPerMinute: number;
  maxConcurrentRequests: number;
  maxQueuedRequests: number;
}

export interface ClipperSecurityConfig {
  allowedHosts: readonly string[];
  sameOrigins: readonly string[];
  allowedHeaders?: readonly string[];
  limits?: Partial<ClipperSecurityLimits>;
}

export type ClipperOriginPolicy =
  | { kind: "same-origin" }
  | { kind: "extension"; expectedOrigin?: string };

export interface ClipperAdmissionPolicy {
  origin: ClipperOriginPolicy;
  readJson?: boolean;
}

export interface ClipperPreflightPolicy {
  origin: ClipperOriginPolicy;
  methods: readonly string[];
  headers?: readonly string[];
}

interface ClipperSecurityFailure {
  ok: false;
  response: Response;
}

type ClipperSecurityResult<T> = { ok: true; value: T } | ClipperSecurityFailure;

export interface ClipperAdmission {
  body?: unknown;
  extensionId?: string;
  origin: string;
  peerAddress: string;
  release(): void;
}

interface RateState {
  count: number;
  windowStartedAt: number;
}

function checkedInteger(
  value: number,
  name: string,
  allowZero = false
): number {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(
      `${name} must be a ${allowZero ? "non-negative" : "positive"} integer`
    );
  }
  return value;
}

function validateHostEntry(host: string): boolean {
  if (host !== host.trim() || host.length === 0) return false;
  if (host.includes("*") || host.includes(",")) return false;
  try {
    const url = new URL(`http://${host}`);
    return (
      url.host.toLowerCase() === host.toLowerCase() &&
      url.pathname === "/" &&
      isLoopbackHostname(url.hostname)
    );
  } catch {
    return false;
  }
}

function validateSameOriginEntry(origin: string): boolean {
  if (origin !== origin.trim() || origin.length === 0 || origin.includes("*")) {
    return false;
  }
  try {
    const url = new URL(origin);
    return (
      url.protocol === "http:" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.origin === origin &&
      isLoopbackHostname(url.hostname)
    );
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost") return true;
  return isClipperLoopbackAddress(hostname.replace(/^\[|\]$/g, ""));
}

function normalizedHeaderNames(headers: readonly string[]): string[] {
  const normalized = headers.map((header) => header.trim().toLowerCase());
  if (
    normalized.some(
      (header) =>
        header.length === 0 ||
        header.includes("*") ||
        !/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(header)
    )
  ) {
    throw new Error("Clipper allowed headers must contain exact header names");
  }
  return [...new Set(normalized)];
}

export function isClipperLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1") return true;
  const mapped = normalized.startsWith("::ffff:")
    ? normalized.slice("::ffff:".length)
    : normalized;
  const octets = mapped.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/.test(octet)) &&
    Number(octets[0]) === 127 &&
    octets.every((octet) => Number(octet) <= 255)
  );
}

export function parseClipperExtensionOrigin(
  origin: string
): { extensionId: string; origin: string } | null {
  const match = CHROME_EXTENSION_ORIGIN.exec(origin);
  const extensionId = match?.groups?.extensionId;
  return extensionId ? { extensionId, origin } : null;
}

export function withClipperCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.append("Vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export class ClipperSecurityBoundary {
  readonly #allowedHosts: readonly string[];
  readonly #sameOrigins: ReadonlySet<string>;
  readonly #allowedHeaders: readonly string[];
  readonly #limits: ClipperSecurityLimits;
  readonly #now: () => number;
  readonly #rates = new Map<string, RateState>();
  readonly #gate: ReaderGate;

  constructor(
    config: ClipperSecurityConfig,
    options: { now?: () => number } = {}
  ) {
    if (
      config.allowedHosts.length === 0 ||
      !config.allowedHosts.every(validateHostEntry)
    ) {
      throw new Error("Clipper allowedHosts must contain exact Host values");
    }
    if (
      config.sameOrigins.length === 0 ||
      !config.sameOrigins.every(validateSameOriginEntry)
    ) {
      throw new Error(
        "Clipper sameOrigins must contain exact loopback HTTP origins"
      );
    }
    const limits = {
      maxBodyBytes: config.limits?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      maxRequestsPerMinute:
        config.limits?.maxRequestsPerMinute ?? DEFAULT_MAX_REQUESTS_PER_MINUTE,
      maxConcurrentRequests:
        config.limits?.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS,
      maxQueuedRequests:
        config.limits?.maxQueuedRequests ?? DEFAULT_MAX_QUEUED_REQUESTS,
    };
    this.#allowedHosts = [...config.allowedHosts];
    this.#sameOrigins = new Set(config.sameOrigins);
    this.#allowedHeaders = normalizedHeaderNames(
      config.allowedHeaders ?? DEFAULT_CLIPPER_ALLOWED_HEADERS
    );
    this.#limits = {
      maxBodyBytes: checkedInteger(limits.maxBodyBytes, "Clipper body limit"),
      maxRequestsPerMinute: checkedInteger(
        limits.maxRequestsPerMinute,
        "Clipper rate limit"
      ),
      maxConcurrentRequests: checkedInteger(
        limits.maxConcurrentRequests,
        "Clipper concurrency limit"
      ),
      maxQueuedRequests: checkedInteger(
        limits.maxQueuedRequests,
        "Clipper concurrency queue limit",
        true
      ),
    };
    this.#now = options.now ?? Date.now;
    this.#gate = new ReaderGate(
      this.#limits.maxConcurrentRequests,
      this.#limits.maxQueuedRequests
    );
  }

  async admit(
    request: Request,
    server: HttpMcpPeerServer,
    policy: ClipperAdmissionPolicy
  ): Promise<ClipperSecurityResult<ClipperAdmission>> {
    const boundary = this.#validateBoundary(request, server, policy.origin);
    if (!boundary.ok) return boundary;
    if (!this.#allowRate(boundary.value.peerAddress)) {
      return {
        ok: false,
        response: withClipperCors(
          clipperSecurityErrorResponse("CLIPPER_RATE_LIMITED"),
          boundary.value.origin
        ),
      };
    }

    let release: (() => void) | undefined;
    try {
      release = await this.#gate.acquire(request.signal);
      let body: unknown;
      if (policy.readJson) {
        const parsed = await readClipperBoundedJson(
          request,
          this.#limits.maxBodyBytes
        );
        if (!parsed.ok) {
          release();
          return {
            ok: false,
            response: withClipperCors(parsed.response, boundary.value.origin),
          };
        }
        body = parsed.value;
      }
      return {
        ok: true,
        value: {
          ...boundary.value,
          body,
          release,
        },
      };
    } catch (error) {
      release?.();
      const code =
        error instanceof Error &&
        error.message === "Resident reader queue is full"
          ? "CLIPPER_BUSY"
          : "CLIPPER_ABORTED";
      return {
        ok: false,
        response: withClipperCors(
          clipperSecurityErrorResponse(code),
          boundary.value.origin
        ),
      };
    }
  }

  handlePreflight(
    request: Request,
    server: HttpMcpPeerServer,
    policy: ClipperPreflightPolicy
  ): Response {
    const boundary = this.#validateBoundary(request, server, policy.origin);
    if (!boundary.ok) return boundary.response;
    if (!this.#allowRate(boundary.value.peerAddress)) {
      return withClipperCors(
        clipperSecurityErrorResponse("CLIPPER_RATE_LIMITED"),
        boundary.value.origin
      );
    }

    const requestedMethod = request.headers
      .get("access-control-request-method")
      ?.toUpperCase();
    const allowedMethods = policy.methods.map((method) => method.toUpperCase());
    if (!requestedMethod || !allowedMethods.includes(requestedMethod)) {
      return clipperSecurityErrorResponse("CLIPPER_FORBIDDEN");
    }
    const allowedHeaders = new Set(
      normalizedHeaderNames(policy.headers ?? this.#allowedHeaders)
    );
    const requestedHeaders = request.headers
      .get("access-control-request-headers")
      ?.split(",")
      .map((header) => header.trim().toLowerCase())
      .filter(Boolean);
    if (
      requestedHeaders?.some((header) => !allowedHeaders.has(header)) ??
      false
    ) {
      return clipperSecurityErrorResponse("CLIPPER_FORBIDDEN");
    }
    const privateNetwork = request.headers.get(
      "access-control-request-private-network"
    );
    if (privateNetwork !== null && privateNetwork !== "true") {
      return clipperSecurityErrorResponse("CLIPPER_FORBIDDEN");
    }

    const headers = new Headers({
      "Access-Control-Allow-Methods": allowedMethods.join(", "),
      "Access-Control-Allow-Origin": boundary.value.origin,
      "Access-Control-Max-Age": String(PREFLIGHT_MAX_AGE_SECONDS),
      Vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network",
    });
    if (requestedHeaders && requestedHeaders.length > 0) {
      headers.set("Access-Control-Allow-Headers", requestedHeaders.join(", "));
    }
    if (privateNetwork === "true") {
      headers.set("Access-Control-Allow-Private-Network", "true");
    }
    return new Response(null, { status: 204, headers });
  }

  #validateBoundary(
    request: Request,
    server: HttpMcpPeerServer,
    policy: ClipperOriginPolicy
  ):
    | {
        ok: true;
        value: { extensionId?: string; origin: string; peerAddress: string };
      }
    | ClipperSecurityFailure {
    const peer = server.requestIP(request);
    if (!peer || !isClipperLoopbackAddress(peer.address)) {
      return {
        ok: false,
        response: clipperSecurityErrorResponse("CLIPPER_FORBIDDEN"),
      };
    }
    const host = request.headers.get("host");
    if (
      !host ||
      !this.#allowedHosts.some(
        (allowedHost) => allowedHost.toLowerCase() === host.toLowerCase()
      )
    ) {
      return {
        ok: false,
        response: clipperSecurityErrorResponse("CLIPPER_FORBIDDEN"),
      };
    }
    const origin = request.headers.get("origin");
    if (!origin) {
      return {
        ok: false,
        response: clipperSecurityErrorResponse("CLIPPER_FORBIDDEN"),
      };
    }
    if (policy.kind === "same-origin") {
      if (!this.#sameOrigins.has(origin)) {
        return {
          ok: false,
          response: clipperSecurityErrorResponse("CLIPPER_FORBIDDEN"),
        };
      }
      return { ok: true, value: { origin, peerAddress: peer.address } };
    }
    const extension = parseClipperExtensionOrigin(origin);
    if (
      !extension ||
      (policy.expectedOrigin && origin !== policy.expectedOrigin)
    ) {
      return {
        ok: false,
        response: clipperSecurityErrorResponse("CLIPPER_FORBIDDEN"),
      };
    }
    return {
      ok: true,
      value: { ...extension, peerAddress: peer.address },
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
        if (now - candidate.windowStartedAt >= RATE_WINDOW_MS) {
          this.#rates.delete(rateKey);
        }
      }
      if (this.#rates.size > MAX_RATE_KEYS) this.#rates.clear();
    }
    return state.count <= this.#limits.maxRequestsPerMinute;
  }
}
