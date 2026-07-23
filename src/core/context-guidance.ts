import type { SearchResult } from "../pipeline/types";
import type { ContextRow } from "../store/types";

import { decorateUriForIndex } from "../app/constants";
import { contextCapsuleContextIdentity } from "./context-capsule-validation";
import {
  contextIdentityFromUri,
  resolveContextSnapshot,
} from "./context-resolver";

export interface ContextConfiguredGuidance {
  contextId: string;
  scopeType: "global" | "collection" | "prefix";
  scopeKey: string;
  text: string;
}

const compareCodeUnits = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

/** A docid is only a short source-hash prefix and cannot identify a document. */
export const contextGuidanceResultIdentity = (
  result: Pick<SearchResult, "docid" | "uri">
): string => JSON.stringify([result.uri, result.docid]);

export const resolveContextGuidance = (
  contextSnapshot: ContextRow[],
  results: SearchResult[],
  indexName: string
): {
  contexts: ContextConfiguredGuidance[];
  idsByResultIdentity: Map<string, string[]>;
} => {
  const byId = new Map<string, ContextConfiguredGuidance>();
  const idsByResultIdentity = new Map<string, string[]>();
  for (const result of results) {
    const ids: string[] = [];
    const identity = contextIdentityFromUri(result.uri);
    const resolved = identity
      ? resolveContextSnapshot(contextSnapshot, identity)
      : undefined;
    for (const provenance of resolved?.provenance ?? []) {
      const guidance = {
        scopeType: provenance.scopeType,
        scopeKey:
          provenance.scopeType === "prefix"
            ? decorateUriForIndex(provenance.normalizedScopeKey, indexName)
            : provenance.normalizedScopeKey,
        text: provenance.text,
      };
      const contextId = contextCapsuleContextIdentity(guidance);
      byId.set(contextId, { contextId, ...guidance });
      ids.push(contextId);
    }
    idsByResultIdentity.set(
      contextGuidanceResultIdentity(result),
      [...new Set(ids)].sort(compareCodeUnits)
    );
  }
  return {
    contexts: [...byId.values()].sort((left, right) =>
      compareCodeUnits(left.contextId, right.contextId)
    ),
    idsByResultIdentity,
  };
};
