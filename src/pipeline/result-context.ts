import type { StorePort } from "../store/types";
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
    .map((result) => ({
      identity: contextIdentityFromUri(result.uri),
      result,
    }))
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
