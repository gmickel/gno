import type { StorePort, SupersessionOptions } from "../store/types";
import type { SearchResult } from "./types";

import {
  ContextResolver,
  contextIdentityFromUri,
} from "../core/context-resolver";

/**
 * Attach configured guidance to an assembled result set with one context-table
 * snapshot read. Context lookup is additive and fail-open so stale or malformed
 * configuration can never turn a successful retrieval into an error.
 */
export async function attachSearchResultContexts(
  store: StorePort,
  results: SearchResult[]
): Promise<void> {
  const validResults = results
    .map((result) => {
      const uriIdentity = contextIdentityFromUri(result.uri);
      return {
        identity: uriIdentity
          ? {
              collection: uriIdentity.collection,
              relPath: result.source.relPath,
            }
          : null,
        result,
      };
    })
    .filter(
      (
        entry
      ): entry is {
        identity: NonNullable<typeof entry.identity>;
        result: SearchResult;
      } => entry.identity !== null
    );

  if (validResults.length === 0) {
    return;
  }

  try {
    const resolver = new ContextResolver(store);
    const resolved = await resolver.resolveMany(
      validResults.map(({ identity }) => identity)
    );
    for (const [index, context] of resolved.entries()) {
      const result = validResults[index]?.result;
      if (result && context) {
        result.context = context.text;
      }
    }
  } catch {
    // Context is optional retrieval metadata. Store/config failures degrade to
    // the historical result shape and are reported by config validation.
  }
}

/**
 * Mark results whose memory fact a newer fact superseded, naming the current
 * successor the caller may read (`options.canFollow`). Fail-open like context
 * guidance: a lookup failure marks nothing.
 */
export async function attachSupersession(
  store: StorePort,
  results: { uri: string; supersededBy?: string }[],
  options?: SupersessionOptions
): Promise<void> {
  if (results.length === 0 || !store.getSupersedingUris) return;
  const successors = await store.getSupersedingUris(
    results.map((result) => result.uri),
    options
  );
  if (!successors.ok) return;
  for (const result of results) {
    const successor = successors.value.get(result.uri);
    if (successor) result.supersededBy = successor;
  }
}

/**
 * Current successor URI of one document's superseded memory fact, if any,
 * limited to successors the caller may read (`options.canFollow`).
 */
export async function supersedingUri(
  store: StorePort,
  uri: string,
  options?: SupersessionOptions
): Promise<string | undefined> {
  if (!store.getSupersedingUris) return undefined;
  const successors = await store.getSupersedingUris([uri], options);
  return successors.ok ? successors.value.get(uri) : undefined;
}

/**
 * Current successor URI of each document's superseded memory fact, from one
 * lookup, limited to successors the caller may read (`options.canFollow`).
 * A lookup failure names none.
 */
export async function supersedingUris(
  store: StorePort,
  uris: string[],
  options?: SupersessionOptions
): Promise<ReadonlyMap<string, string>> {
  if (uris.length === 0 || !store.getSupersedingUris) return new Map();
  const successors = await store.getSupersedingUris(uris, options);
  return successors.ok ? successors.value : new Map();
}
