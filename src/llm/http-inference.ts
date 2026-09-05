/** Policy-gated, DNS-pinned HTTP transport shared by inference adapters. */

import type { Collection } from "../config/types";
import type { CollectionEgressState } from "../core/egress-policy";
import type { EgressDestinationZone } from "../core/egress-policy";
import type {
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
import { classifyHttpDestination, prepareHttpDestination } from "./http-policy";

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
  const states = scopedStates(options);
  if (states.length === 0) {
    enforce(states, "remote", options);
  }
  const maximumZone = maximumDestinationZoneForCollections(
    options.collections,
    options.collectionNames
  );

  // DNS-only classification carries no headers, body, credentials, or model
  // metadata. Policy evaluates the proven zone before transport preparation.
  const classification = await classifyHttpDestination(rawUrl, {
    resolver: options.resolver,
  });
  if (!classification.ok) {
    throw new EgressDeniedError(
      evaluateEgressPolicy({
        collections: states,
        action: "remote_inference",
        destination: { zone: classification.classification.zone },
        caller: {
          authenticated: options.authenticated ?? true,
          operationAuthorized: false,
        },
        contentClass: "source",
      })
    );
  }
  enforce(states, classification.classification.zone, options);
  const url = new URL(rawUrl);

  let prepared = await prepareHttpDestination(url.href, {
    maximumZone,
    resolver: options.resolver,
    remoteProvider: classification.classification.zone === "remote",
    env: options.env,
  });
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

  let currentUrl = url;
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
