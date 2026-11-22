/** Policy-gated, DNS-pinned HTTP transport shared by inference adapters. */

import type { Collection } from "../config/types";
import type { CollectionEgressState } from "../core/egress-policy";
import type { EgressDestinationZone } from "../core/egress-policy";
import type {
  HttpDestinationMaximumZone,
  HttpDestinationPolicyOptions,
  HttpDestinationResolver,
  PinnedHttpFetch,
} from "./http-policy";

import {
  collectionEgressStates,
  EgressDeniedError,
  maximumDestinationZoneForCollections,
} from "../core/egress-enforcement";
import { evaluateEgressPolicy } from "../core/egress-policy";
import { EgressProvenanceError } from "../core/egress-provenance";
import { prepareClassifiedHttpDestination } from "./http-policy";

const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);

export interface HttpInferenceOptions {
  /** Resolved models.inferenceTimeout; measured across the complete HTTP call. */
  inferenceTimeout?: number;
  collections: readonly Collection[];
  collectionNames: readonly string[];
  authenticated?: boolean;
  operationAuthorized?: boolean;
  resolver?: HttpDestinationResolver;
  fetchFn?: PinnedHttpFetch;
  env?: HttpDestinationPolicyOptions["env"];
}

export interface CachedHttpInferenceContext {
  readonly rawUrl: string;
  readonly parsedUrl: URL | null;
  readonly policyKey: string;
  readonly states: readonly CollectionEgressState[];
  readonly maximumZone: HttpDestinationMaximumZone | null;
}

const CONTEXT_CACHE = new WeakMap<
  HttpInferenceOptions,
  CachedHttpInferenceContext
>();
const PARSED_URL_CACHE = new WeakMap<
  HttpInferenceOptions,
  { rawUrl: string; parsedUrl: URL | null }
>();

function computePolicyCacheKey(options: HttpInferenceOptions): string {
  // Fast fingerprint of current collection scope + live egressPolicy values so
  // any in-place policy mutation invalidates the cached states immediately.
  const parts: string[] = [
    String(options.collections.length),
    options.collectionNames.join("\0"),
  ];
  for (let i = 0; i < options.collections.length; i += 1) {
    const col = options.collections[i]!;
    parts.push(`${col.name}:${col.egressPolicy ?? ""}`);
  }
  return parts.join("|");
}

function getCachedParsedUrl(
  rawUrl: string,
  options: HttpInferenceOptions
): URL | null {
  const existing = PARSED_URL_CACHE.get(options);
  if (existing && existing.rawUrl === rawUrl) {
    return existing.parsedUrl;
  }
  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    parsedUrl = null;
  }
  PARSED_URL_CACHE.set(options, { rawUrl, parsedUrl });
  return parsedUrl;
}

const scopedStates = (
  options: HttpInferenceOptions
): readonly CollectionEgressState[] => {
  try {
    return collectionEgressStates(options.collections, options.collectionNames);
  } catch (error) {
    if (error instanceof EgressProvenanceError) return [];
    throw error;
  }
};

function buildHttpInferenceContext(
  rawUrl: string,
  options: HttpInferenceOptions,
  policyKey: string
): CachedHttpInferenceContext {
  const parsedUrl = getCachedParsedUrl(rawUrl, options);
  const states = scopedStates(options);
  const maximumZone =
    states.length === 0
      ? null
      : maximumDestinationZoneForCollections(
          options.collections,
          options.collectionNames
        );
  return { rawUrl, parsedUrl, policyKey, states, maximumZone };
}

/** Pre-parse URL and egress policy once per HTTP inference port instance. */
export function primeHttpInferenceContext(
  rawUrl: string,
  options: HttpInferenceOptions
): void {
  const policyKey = computePolicyCacheKey(options);
  CONTEXT_CACHE.set(
    options,
    buildHttpInferenceContext(rawUrl, options, policyKey)
  );
}

const enforce = (
  states: readonly CollectionEgressState[],
  zone: EgressDestinationZone,
  options: HttpInferenceOptions
): void => {
  const decision = evaluateEgressPolicy({
    collections: states,
    action: "remote_inference",
    destination: { zone },
    caller: {
      authenticated: options.authenticated ?? true,
      operationAuthorized: options.operationAuthorized ?? true,
    },
    contentClass: "source",
  });
  if (!decision.allowed) throw new EgressDeniedError(decision);
};

export const requestHttpInference = async (
  rawUrl: string,
  init: BunFetchRequestInit,
  options: HttpInferenceOptions
): Promise<Response> => {
  init.signal?.throwIfAborted();
  const policyKey = computePolicyCacheKey(options);
  const cached = CONTEXT_CACHE.get(options);
  let ctx: CachedHttpInferenceContext;
  if (cached && cached.rawUrl === rawUrl && cached.policyKey === policyKey) {
    ctx = cached;
  } else {
    ctx = buildHttpInferenceContext(rawUrl, options, policyKey);
    CONTEXT_CACHE.set(options, ctx);
  }
  const { states } = ctx;
  if (states.length === 0) {
    enforce(states, "remote", options);
  }
  const maximumZone =
    ctx.maximumZone ??
    maximumDestinationZoneForCollections(
      options.collections,
      options.collectionNames
    );

  // Merged classify + prepare performs 1 DNS lookup (evaluating collection
  // policy on the proven zone before transport/proxy/HTTPS checks), followed
  // by acquireConnection()'s independent pre-connect DNS rebinding check (2
  // DNS lookups total).
  let prepared = await prepareClassifiedHttpDestination(
    ctx.parsedUrl ?? rawUrl,
    {
      maximumZone,
      resolver: options.resolver,
      env: options.env,
      assertZoneAllowed: (classification) => {
        enforce(states, classification.zone, options);
      },
    }
  );
  if (!prepared.ok) {
    throw new EgressDeniedError(
      evaluateEgressPolicy({
        collections: states,
        action: "remote_inference",
        destination: { zone: prepared.classification.zone },
        caller: {
          authenticated: options.authenticated ?? true,
          operationAuthorized: false,
        },
        contentClass: "source",
      })
    );
  }

  let currentUrl = ctx.parsedUrl ?? new URL(rawUrl);
  for (;;) {
    init.signal?.throwIfAborted();
    enforce(states, prepared.value.classification.zone, options);
    const connection = await prepared.value.acquireConnection();
    if (!connection.ok) {
      throw new EgressDeniedError(
        evaluateEgressPolicy({
          collections: states,
          action: "remote_inference",
          destination: { zone: connection.classification.zone },
          caller: {
            authenticated: options.authenticated ?? true,
            operationAuthorized: false,
          },
          contentClass: "source",
        })
      );
    }
    init.signal?.throwIfAborted();
    const response = await connection.value.request(init, options.fetchFn);
    init.signal?.throwIfAborted();
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get("location");
    if (!location) return response;
    const nextUrl = new URL(location, currentUrl);
    if (nextUrl.origin.toLowerCase() !== currentUrl.origin.toLowerCase()) {
      throw new EgressDeniedError(
        evaluateEgressPolicy({
          collections: states,
          action: "remote_inference",
          destination: { zone: prepared.value.classification.zone },
          caller: {
            authenticated: options.authenticated ?? true,
            operationAuthorized: false,
          },
          contentClass: "source",
        })
      );
    }
    const next = await prepared.value.followRedirect(nextUrl.href);
    if (!next.ok) {
      throw new EgressDeniedError(
        evaluateEgressPolicy({
          collections: states,
          action: "remote_inference",
          destination: { zone: next.classification.zone },
          caller: {
            authenticated: options.authenticated ?? true,
            operationAuthorized: false,
          },
          contentClass: "source",
        })
      );
    }
    currentUrl = nextUrl;
    prepared = next;
  }
};
