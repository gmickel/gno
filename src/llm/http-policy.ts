/** DNS-pinned, redirect-aware destination policy for outbound HTTP inference. */

import type { DestinationClassification } from "../core/destination-classifier";
import type { HttpDestinationPolicyAudit } from "./pinned-http-connection";

import {
  classifyDestination,
  isNetworkAddress,
} from "../core/destination-classifier";
import { PinnedHttpConnection } from "./pinned-http-connection";

export type {
  HttpDestinationPolicyAudit,
  PinnedHttpFetch,
} from "./pinned-http-connection";
export {
  PinnedHttpConnection,
  PinnedHttpRequestError,
} from "./pinned-http-connection";

export const MAX_HTTP_DESTINATION_ADDRESSES = 32;
export const MAX_HTTP_DESTINATION_REDIRECTS = 5;

export const HTTP_DESTINATION_POLICY_REASONS = [
  "DESTINATION_ALLOWED",
  "INVALID_DESTINATION",
  "UNSUPPORTED_PROTOCOL",
  "CREDENTIALS_IN_URL",
  "DNS_UNRESOLVED",
  "DNS_INVALID_ANSWER",
  "DNS_RESULT_LIMIT",
  "ZONE_NOT_ALLOWED",
  "PROVIDER_ADDRESS_NOT_PUBLIC",
  "PROVIDER_HTTPS_REQUIRED",
  "PROXY_ENVIRONMENT_ACTIVE",
  "DNS_REBINDING",
  "INVALID_REDIRECT_COUNT",
  "REDIRECT_LIMIT",
  "REDIRECT_ZONE_CHANGED",
  "PROVIDER_REDIRECT_ORIGIN_CHANGED",
  "HTTPS_DOWNGRADE",
] as const;
export type HttpDestinationPolicyReason =
  (typeof HTTP_DESTINATION_POLICY_REASONS)[number];

export type HttpDestinationMaximumZone = "loopback" | "lan" | "remote";

export interface HttpDestinationPolicyDenial {
  ok: false;
  reason: Exclude<HttpDestinationPolicyReason, "DESTINATION_ALLOWED">;
  classification: DestinationClassification;
  audit: HttpDestinationPolicyAudit;
}

export interface HttpDestinationResolver {
  lookup(hostname: string, port: number): Promise<readonly string[]>;
}

export interface HttpDestinationPolicyOptions {
  maximumZone: HttpDestinationMaximumZone;
  resolver?: HttpDestinationResolver;
  remoteProvider?: boolean;
  env?: Readonly<Record<string, string | undefined>>;
}

export type HttpDestinationConnectionResult =
  | { ok: true; value: PinnedHttpConnection }
  | HttpDestinationPolicyDenial;

export type HttpDestinationPolicyResult =
  | { ok: true; reason: "DESTINATION_ALLOWED"; value: HttpDestinationPin }
  | HttpDestinationPolicyDenial;

export type HttpDestinationClassificationResult =
  | {
      ok: true;
      reason: "DESTINATION_ALLOWED";
      classification: DestinationClassification;
    }
  | HttpDestinationPolicyDenial;

const ZONE_ORDER: Record<HttpDestinationMaximumZone, number> = {
  loopback: 0,
  lan: 1,
  remote: 2,
};
const PROXY_ENV_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

const defaultResolver: HttpDestinationResolver = {
  async lookup(hostname: string, port: number): Promise<readonly string[]> {
    const results = await Bun.dns.lookup(hostname, {
      family: "any",
      socketType: "tcp",
      port,
    });
    return results.map(({ address }) => address);
  },
};

function normalizeHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1).toLowerCase()
    : hostname.toLowerCase();
}

function normalizeAddresses(addresses: readonly string[]): string[] {
  return [...new Set(addresses.map((address) => address.trim().toLowerCase()))]
    .filter(Boolean)
    .sort();
}

function protocolFor(url: URL): HttpDestinationPolicyAudit["protocol"] {
  if (url.protocol === "http:") return "http";
  if (url.protocol === "https:") return "https";
  return "unknown";
}

function portFor(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function hasActiveProxy(
  env: Readonly<Record<string, string | undefined>>
): boolean {
  return PROXY_ENV_NAMES.some((name) => Boolean(env[name]?.trim()));
}

function invalidClassification(): DestinationClassification {
  return classifyDestination({ kind: "network" });
}

function createAudit(
  classification: DestinationClassification,
  url: URL | null,
  redirectCount: number
): HttpDestinationPolicyAudit {
  return {
    protocol: url ? protocolFor(url) : "unknown",
    port: url ? portFor(url) : null,
    redirectCount,
    classification: classification.audit,
  };
}

function denial(
  reason: HttpDestinationPolicyDenial["reason"],
  classification: DestinationClassification,
  url: URL | null,
  redirectCount: number
): HttpDestinationPolicyDenial {
  return {
    ok: false,
    reason,
    classification,
    audit: createAudit(classification, url, redirectCount),
  };
}

function zoneAllowed(
  actual: DestinationClassification["zone"],
  maximum: HttpDestinationMaximumZone
): boolean {
  if (actual === "local_process") return true;
  return ZONE_ORDER[actual] <= ZONE_ORDER[maximum];
}

async function resolveAddresses(
  url: URL,
  resolver: HttpDestinationResolver
): Promise<
  | { ok: true; hostname: string; addresses: string[] }
  | {
      ok: false;
      reason: "DNS_UNRESOLVED" | "DNS_INVALID_ANSWER" | "DNS_RESULT_LIMIT";
    }
> {
  const hostname = normalizeHostname(url.hostname);
  if (isNetworkAddress(hostname)) {
    return { ok: true, hostname, addresses: [hostname] };
  }
  try {
    const raw = await resolver.lookup(hostname, portFor(url));
    if (raw.length > MAX_HTTP_DESTINATION_ADDRESSES) {
      return { ok: false, reason: "DNS_RESULT_LIMIT" };
    }
    const addresses = normalizeAddresses(raw);
    if (addresses.length === 0) {
      return { ok: false, reason: "DNS_UNRESOLVED" };
    }
    if (
      addresses.some(
        (address) => address.includes("%") || !isNetworkAddress(address)
      )
    ) {
      return { ok: false, reason: "DNS_INVALID_ANSWER" };
    }
    return { ok: true, hostname, addresses };
  } catch {
    return { ok: false, reason: "DNS_UNRESOLVED" };
  }
}

function parseHttpUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

function providerAddressesArePublic(
  classification: DestinationClassification
): boolean {
  return (
    classification.audit.addressClasses.length === 1 &&
    classification.audit.addressClasses[0] === "public"
  );
}

interface PreparedDestination {
  url: URL;
  hostname: string;
  addresses: string[];
  classification: DestinationClassification;
}

function freezeClassification(
  classification: DestinationClassification
): DestinationClassification {
  const audit = Object.freeze({
    ...classification.audit,
    addressClasses: Object.freeze([...classification.audit.addressClasses]),
  });
  return Object.freeze({ ...classification, audit });
}

function isPolicyDenial(
  value: PreparedDestination | HttpDestinationPolicyDenial
): value is HttpDestinationPolicyDenial {
  return "ok" in value && value.ok === false;
}

async function prepareDestination(
  rawUrl: string,
  options: Required<
    Pick<HttpDestinationPolicyOptions, "maximumZone" | "remoteProvider" | "env">
  > & { resolver: HttpDestinationResolver },
  redirectCount: number
): Promise<PreparedDestination | HttpDestinationPolicyDenial> {
  const url = parseHttpUrl(rawUrl);
  const invalid = invalidClassification();
  if (!url) return denial("INVALID_DESTINATION", invalid, null, redirectCount);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return denial("UNSUPPORTED_PROTOCOL", invalid, url, redirectCount);
  }
  if (url.username || url.password) {
    return denial("CREDENTIALS_IN_URL", invalid, url, redirectCount);
  }
  if (options.remoteProvider && url.protocol !== "https:") {
    return denial("PROVIDER_HTTPS_REQUIRED", invalid, url, redirectCount);
  }
  if (options.maximumZone !== "remote" && hasActiveProxy(options.env)) {
    return denial("PROXY_ENVIRONMENT_ACTIVE", invalid, url, redirectCount);
  }

  const resolved = await resolveAddresses(url, options.resolver);
  if (!resolved.ok) {
    return denial(resolved.reason, invalid, url, redirectCount);
  }
  const classification = classifyDestination({
    kind: "network",
    hostname: resolved.hostname,
    addresses: resolved.addresses,
    remoteProvider: options.remoteProvider,
  });
  if (options.remoteProvider && !providerAddressesArePublic(classification)) {
    return denial(
      "PROVIDER_ADDRESS_NOT_PUBLIC",
      classification,
      url,
      redirectCount
    );
  }
  if (!zoneAllowed(classification.zone, options.maximumZone)) {
    return denial("ZONE_NOT_ALLOWED", classification, url, redirectCount);
  }
  return {
    url,
    hostname: resolved.hostname,
    addresses: resolved.addresses,
    classification,
  };
}

/**
 * Opaque DNS pin. JSON/log projection is intentionally redacted; raw connection
 * details are released only by acquireConnection() after an exact DNS recheck.
 */
export class HttpDestinationPin {
  readonly #classification: DestinationClassification;
  readonly #classificationZone: DestinationClassification["zone"];
  readonly #url: URL;
  readonly #hostname: string;
  readonly #addresses: readonly string[];
  readonly #maximumZone: HttpDestinationMaximumZone;
  readonly #resolver: HttpDestinationResolver;
  readonly #remoteProvider: boolean;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #redirectCount: number;

  constructor(
    prepared: PreparedDestination,
    options: Required<
      Pick<
        HttpDestinationPolicyOptions,
        "maximumZone" | "remoteProvider" | "env"
      >
    > & { resolver: HttpDestinationResolver },
    redirectCount: number
  ) {
    this.#classification = freezeClassification(prepared.classification);
    this.#classificationZone = prepared.classification.zone;
    this.#url = prepared.url;
    this.#hostname = prepared.hostname;
    this.#addresses = prepared.addresses;
    this.#maximumZone = options.maximumZone;
    this.#resolver = options.resolver;
    this.#remoteProvider = options.remoteProvider;
    this.#env = options.env;
    this.#redirectCount = redirectCount;
  }

  toJSON(): {
    classification: DestinationClassification;
    audit: HttpDestinationPolicyAudit;
  } {
    return {
      classification: this.#classification,
      audit: createAudit(this.#classification, this.#url, this.#redirectCount),
    };
  }

  get classification(): DestinationClassification {
    return this.#classification;
  }

  async acquireConnection(): Promise<HttpDestinationConnectionResult> {
    const prepared = await prepareDestination(
      this.#url.href,
      {
        maximumZone: this.#maximumZone,
        resolver: this.#resolver,
        remoteProvider: this.#remoteProvider,
        env: this.#env,
      },
      this.#redirectCount
    );
    if (isPolicyDenial(prepared)) {
      return denial(
        "DNS_REBINDING",
        prepared.classification,
        this.#url,
        this.#redirectCount
      );
    }
    if (
      prepared.addresses.length !== this.#addresses.length ||
      prepared.addresses.some(
        (address, index) => address !== this.#addresses[index]
      )
    ) {
      return denial(
        "DNS_REBINDING",
        prepared.classification,
        this.#url,
        this.#redirectCount
      );
    }

    const address = this.#addresses[0];
    if (!address) {
      return denial(
        "DNS_UNRESOLVED",
        this.#classification,
        this.#url,
        this.#redirectCount
      );
    }
    const target = new URL(this.#url.href);
    target.hostname = address.includes(":") ? `[${address}]` : address;
    return {
      ok: true,
      value: new PinnedHttpConnection(
        target.href,
        this.#url.host,
        isNetworkAddress(this.#hostname) ? undefined : this.#hostname,
        createAudit(this.#classification, this.#url, this.#redirectCount)
      ),
    };
  }

  async followRedirect(location: string): Promise<HttpDestinationPolicyResult> {
    if (this.#redirectCount >= MAX_HTTP_DESTINATION_REDIRECTS) {
      return denial(
        "REDIRECT_LIMIT",
        this.#classification,
        this.#url,
        this.#redirectCount
      );
    }
    let nextUrl: URL;
    try {
      nextUrl = new URL(location, this.#url);
    } catch {
      return denial(
        "INVALID_DESTINATION",
        invalidClassification(),
        null,
        this.#redirectCount + 1
      );
    }
    if (this.#url.protocol === "https:" && nextUrl.protocol === "http:") {
      return denial(
        "HTTPS_DOWNGRADE",
        invalidClassification(),
        nextUrl,
        this.#redirectCount + 1
      );
    }
    if (
      this.#remoteProvider &&
      nextUrl.origin.toLowerCase() !== this.#url.origin.toLowerCase()
    ) {
      return denial(
        "PROVIDER_REDIRECT_ORIGIN_CHANGED",
        invalidClassification(),
        nextUrl,
        this.#redirectCount + 1
      );
    }
    const next = await prepareHttpDestination(nextUrl.href, {
      maximumZone: this.#maximumZone,
      resolver: this.#resolver,
      remoteProvider: this.#remoteProvider,
      env: this.#env,
      redirectCount: this.#redirectCount + 1,
    });
    if (!next.ok) return next;
    if (next.value.classification.zone !== this.#classificationZone) {
      return denial(
        "REDIRECT_ZONE_CHANGED",
        next.value.classification,
        nextUrl,
        this.#redirectCount + 1
      );
    }
    return next;
  }
}

export async function prepareHttpDestination(
  rawUrl: string,
  options: HttpDestinationPolicyOptions & { redirectCount?: number }
): Promise<HttpDestinationPolicyResult> {
  const redirectCount =
    options.redirectCount === undefined ? 0 : options.redirectCount;
  if (!Number.isSafeInteger(redirectCount) || redirectCount < 0) {
    return denial("INVALID_REDIRECT_COUNT", invalidClassification(), null, 0);
  }
  if (redirectCount > MAX_HTTP_DESTINATION_REDIRECTS) {
    return denial(
      "REDIRECT_LIMIT",
      invalidClassification(),
      null,
      redirectCount
    );
  }
  const resolvedOptions = {
    maximumZone: options.maximumZone,
    resolver: options.resolver ?? defaultResolver,
    remoteProvider: options.remoteProvider ?? false,
    env: options.env ?? process.env,
  };
  const prepared = await prepareDestination(
    rawUrl,
    resolvedOptions,
    redirectCount
  );
  if (isPolicyDenial(prepared)) return prepared;
  return {
    ok: true,
    reason: "DESTINATION_ALLOWED",
    value: new HttpDestinationPin(prepared, resolvedOptions, redirectCount),
  };
}

/**
 * Resolve, classify, and prepare an HTTP destination in one DNS lookup phase
 * (eliminating the duplicate lookup between classifyHttpDestination and
 * prepareHttpDestination). The caller's `assertZoneAllowed` runs against the
 * proven network zone before transport/proxy/HTTPS policy checks, and
 * `HttpDestinationPin.acquireConnection()` still performs its independent
 * pre-connect DNS rebinding check.
 */
export async function prepareClassifiedHttpDestination(
  rawUrl: string | URL,
  options: Omit<HttpDestinationPolicyOptions, "remoteProvider"> & {
    redirectCount?: number;
    assertZoneAllowed?: (classification: DestinationClassification) => void;
  }
): Promise<HttpDestinationPolicyResult> {
  const redirectCount =
    options.redirectCount === undefined ? 0 : options.redirectCount;
  if (!Number.isSafeInteger(redirectCount) || redirectCount < 0) {
    return denial("INVALID_REDIRECT_COUNT", invalidClassification(), null, 0);
  }
  if (redirectCount > MAX_HTTP_DESTINATION_REDIRECTS) {
    return denial(
      "REDIRECT_LIMIT",
      invalidClassification(),
      null,
      redirectCount
    );
  }
  const url = typeof rawUrl === "string" ? parseHttpUrl(rawUrl) : rawUrl;
  const invalid = invalidClassification();
  if (!url) return denial("INVALID_DESTINATION", invalid, null, redirectCount);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return denial("UNSUPPORTED_PROTOCOL", invalid, url, redirectCount);
  }
  if (url.username || url.password) {
    return denial("CREDENTIALS_IN_URL", invalid, url, redirectCount);
  }

  const resolver = options.resolver ?? defaultResolver;
  const env = options.env ?? process.env;
  const resolved = await resolveAddresses(url, resolver);
  if (!resolved.ok) {
    return denial(resolved.reason, invalid, url, redirectCount);
  }

  const initialClassification = classifyDestination({
    kind: "network",
    hostname: resolved.hostname,
    addresses: resolved.addresses,
  });
  options.assertZoneAllowed?.(initialClassification);

  const remoteProvider = initialClassification.zone === "remote";
  if (remoteProvider && url.protocol !== "https:") {
    return denial("PROVIDER_HTTPS_REQUIRED", invalid, url, redirectCount);
  }
  if (options.maximumZone !== "remote" && hasActiveProxy(env)) {
    return denial("PROXY_ENVIRONMENT_ACTIVE", invalid, url, redirectCount);
  }

  const classification = remoteProvider
    ? classifyDestination({
        kind: "network",
        hostname: resolved.hostname,
        addresses: resolved.addresses,
        remoteProvider: true,
      })
    : initialClassification;
  if (remoteProvider && !providerAddressesArePublic(classification)) {
    return denial(
      "PROVIDER_ADDRESS_NOT_PUBLIC",
      classification,
      url,
      redirectCount
    );
  }
  if (!zoneAllowed(classification.zone, options.maximumZone)) {
    return denial("ZONE_NOT_ALLOWED", classification, url, redirectCount);
  }

  return {
    ok: true,
    reason: "DESTINATION_ALLOWED",
    value: new HttpDestinationPin(
      {
        url,
        hostname: resolved.hostname,
        addresses: resolved.addresses,
        classification,
      },
      {
        maximumZone: options.maximumZone,
        resolver,
        remoteProvider,
        env,
      },
      redirectCount
    ),
  };
}

/**
 * Resolve and classify an HTTP destination without opening a socket or
 * transferring request headers/body. This bounded DNS-only phase lets the
 * collection policy evaluate a hostname's proven zone before transport setup.
 */
export async function classifyHttpDestination(
  rawUrl: string,
  options: Pick<HttpDestinationPolicyOptions, "resolver">
): Promise<HttpDestinationClassificationResult> {
  const url = parseHttpUrl(rawUrl);
  const invalid = invalidClassification();
  if (!url) return denial("INVALID_DESTINATION", invalid, null, 0);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return denial("UNSUPPORTED_PROTOCOL", invalid, url, 0);
  }
  if (url.username || url.password) {
    return denial("CREDENTIALS_IN_URL", invalid, url, 0);
  }
  const resolved = await resolveAddresses(
    url,
    options.resolver ?? defaultResolver
  );
  if (!resolved.ok) return denial(resolved.reason, invalid, url, 0);
  return {
    ok: true,
    reason: "DESTINATION_ALLOWED",
    classification: classifyDestination({
      kind: "network",
      hostname: resolved.hostname,
      addresses: resolved.addresses,
    }),
  };
}
