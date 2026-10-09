/**
 * MCP side of collection access (opt-in, see `src/core/access-scope.ts`).
 *
 * Every helper is a no-op unless the current request came from a non-admin
 * gateway principal, so stdio, `gno serve` and unnamed callers keep their
 * exact behavior and output.
 *
 * @module src/mcp/tools/access
 */

import type { DocumentRow, StorePort } from "../../store/types";
import type { ToolContext } from "../server";

import {
  type AccessRequest,
  accessNotFound,
  accessRuleAdmitsWrite,
  authorizedCollectionNames,
  derivedFromIssue,
  isAccessMode,
  withDerivedFromRequired,
} from "../../core/access-scope";

/** Collections the current request may read; absent when unrestricted. */
export interface McpAccessScope {
  collections: string[];
  canRead(collection: string): boolean;
}

export const accessRequestOf = (ctx: ToolContext): AccessRequest => ({
  principal: ctx.getRequestPrincipal?.(),
  subject: ctx.getRequestSubject?.(),
});

/** The request's access scope, or null when it is not in access mode. */
export const mcpAccessScope = (ctx: ToolContext): McpAccessScope | null => {
  const names = authorizedCollectionNames(
    ctx.collections,
    accessRequestOf(ctx)
  );
  if (names === undefined) return null;
  const allowed = new Set(names);
  return { collections: names, canRead: (name) => allowed.has(name) };
};

/** In access mode, only the owner may write into an `owner` collection. */
export const assertMemoryWritable = (
  ctx: ToolContext,
  collection: string
): void => {
  const request = accessRequestOf(ctx);
  if (!isAccessMode(request)) return;
  const access = ctx.collections.find((c) => c.name === collection)?.access;
  if (!accessRuleAdmitsWrite(access, request)) throw accessNotFound();
};

/** In access mode, a memory read needs a readable collection. */
export const assertMemoryReadable = (
  ctx: ToolContext,
  collection: string
): void => {
  const scope = mcpAccessScope(ctx);
  if (scope && !scope.canRead(collection)) throw accessNotFound();
};

/** Throw NOT_FOUND for any named collection the scope cannot read. */
export const assertCollectionsReadable = (
  scope: McpAccessScope,
  names: readonly (string | undefined)[]
): void => {
  for (const name of names) {
    if (name !== undefined && !scope.canRead(name)) throw accessNotFound();
  }
};

/** Whether an indexed document may be served in this scope. */
export const isDocumentServable = (
  scope: McpAccessScope,
  doc: Pick<
    DocumentRow,
    "active" | "collection" | "mirrorHash" | "typedMetadata" | "metadataError"
  >
): boolean =>
  doc.active &&
  scope.canRead(doc.collection) &&
  doc.mirrorHash !== null &&
  derivedFromIssue(doc.typedMetadata, doc.metadataError) === null;

/**
 * Pre-limit corpus scope that keeps documents with an invalid `derived_from`
 * out of retrieval: candidates, graph neighbours, the reranker and the limit.
 * The `derived_from` presence filter already drops documents without the key,
 * so this returns an empty object (no extra restriction) unless a readable
 * collection holds a document whose `derived_from` is present but invalid.
 * Then it returns an allowlist of the servable documents' mirror hashes, minus
 * any hash an invalid document shares (fail closed).
 */
export const provenanceRetrievalScope = async (
  scope: McpAccessScope,
  store: Pick<StorePort, "listDocuments">
): Promise<{ retrievalScope?: { allowedMirrorHashes: string[] } }> => {
  const servable = new Set<string>();
  const invalid = new Set<string>();
  for (const name of scope.collections) {
    const docs = await store.listDocuments(name);
    if (!docs.ok) throw new Error(docs.error.message);
    for (const doc of docs.value) {
      if (!doc.active || doc.mirrorHash === null) continue;
      if (isDocumentServable(scope, doc)) servable.add(doc.mirrorHash);
      else if (
        !doc.metadataError &&
        derivedFromIssue(doc.typedMetadata) === "invalid"
      ) {
        invalid.add(doc.mirrorHash);
      }
    }
  }
  if (invalid.size === 0) return {};
  return {
    retrievalScope: {
      allowedMirrorHashes: [...servable].filter((hash) => !invalid.has(hash)),
    },
  };
};

interface RetrievalArgs {
  collection?: string;
  collections?: string[];
  filter?: unknown;
  explain?: boolean;
}

/**
 * Narrow retrieval arguments to the scope, before the limit: named
 * collections must be readable (else NOT_FOUND, the same as a missing one),
 * no collection means every readable one (none denies all), documents must
 * declare `derived_from`, and `explain` is off.
 */
export const scopeRetrievalArgs = <T extends RetrievalArgs>(
  scope: McpAccessScope,
  args: T
): T => {
  assertCollectionsReadable(scope, [
    args.collection,
    ...(args.collections ?? []),
  ]);
  const scoped: RetrievalArgs = {
    ...args,
    collections:
      args.collection === undefined && args.collections === undefined
        ? scope.collections
        : args.collections,
    filter: withDerivedFromRequired(args.filter),
  };
  if ("explain" in args) scoped.explain = undefined;
  return scoped as T;
};

interface RetrievalResult {
  results: { docid: string }[];
  meta: { totalResults: number; collections?: string[] };
}

/**
 * Backstop after retrieval: drop any result whose document is not servable
 * (e.g. it changed since `provenanceRetrievalScope` ran) and hide the
 * collection list the scope injected.
 */
export const finishScopedRetrieval = async <T extends RetrievalResult>(
  scope: McpAccessScope,
  store: StorePort,
  callerCollections: string[] | undefined,
  value: T
): Promise<T> => {
  const results: T["results"] = [];
  for (const result of value.results) {
    const doc = await store.getDocumentByDocid(result.docid);
    if (doc.ok && doc.value && isDocumentServable(scope, doc.value)) {
      results.push(result);
    }
  }
  const meta = { ...value.meta, totalResults: results.length };
  if (callerCollections === undefined) delete meta.collections;
  else meta.collections = callerCollections;
  return { ...value, results, meta } as T;
};
