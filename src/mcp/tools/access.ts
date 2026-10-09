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
 * Drop results whose document is no longer servable (an invalid
 * `derived_from` passes the pre-limit presence check) and hide the
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
