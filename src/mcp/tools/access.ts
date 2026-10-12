/**
 * MCP side of collection access (opt-in, see `src/core/access-scope.ts`).
 *
 * Every helper is a no-op unless the current request came from a non-admin
 * gateway principal, so stdio, `gno serve` and unnamed callers keep their
 * exact behavior and output.
 *
 * @module src/mcp/tools/access
 */

import type { EgressLineage } from "../../core/egress-provenance";
import type { RecallResult } from "../../core/memory";
import type {
  DocumentRow,
  StorePort,
  SupersessionOptions,
} from "../../store/types";
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
import {
  createEgressLineage,
  mergeEgressLineages,
} from "../../core/egress-provenance";

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

/**
 * Caller scope for `supersededBy` links: a successor is named only when this
 * scope could serve it, so a hidden document never appears in the link and
 * never bridges a supersession chain to a readable one.
 */
export const supersessionScope = (
  scope: McpAccessScope,
  store: Pick<StorePort, "getDocumentByUri">
): SupersessionOptions => ({
  canFollow: async (uri) => {
    const doc = await store.getDocumentByUri(uri);
    return doc.ok && doc.value !== null && isDocumentServable(scope, doc.value);
  },
});

/**
 * Retrieval options that confine one search, query or Context Capsule to the
 * scope: the provenance allowlist and the `supersededBy` filter.
 */
export const accessRetrievalOptions = async (
  scope: McpAccessScope,
  store: Pick<StorePort, "listDocuments" | "getDocumentByUri">
): Promise<{
  retrievalScope?: { allowedMirrorHashes: string[] };
  supersession: SupersessionOptions;
}> => ({
  ...(await provenanceRetrievalScope(scope, store)),
  supersession: supersessionScope(scope, store),
});

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

/**
 * The caller's view of a policy lineage: only the sources this scope can
 * read. A result's lineage lists every active owner of its content, so a
 * hidden collection holding the same bytes would otherwise be named. The
 * complete lineage stays internal (retrieval traces record it before this
 * projection) for egress decisions. Empty after projection fails closed.
 */
export const visibleEgressLineage = (
  scope: McpAccessScope,
  lineage: EgressLineage
): EgressLineage => {
  const sources = lineage.sources.filter((source) =>
    scope.canRead(source.collection)
  );
  return sources.length === lineage.sources.length
    ? lineage
    : createEgressLineage(sources);
};

/** Recall output with every lineage projected to the caller's scope. */
export const scopeRecallResult = (
  scope: McpAccessScope,
  value: RecallResult
): RecallResult => {
  if (value.facts.length === 0) return value;
  const facts = value.facts.map((fact) => ({
    ...fact,
    egressLineage: visibleEgressLineage(scope, fact.egressLineage),
  }));
  return {
    ...value,
    facts,
    egressLineage: mergeEgressLineages(facts.map((f) => f.egressLineage)),
  };
};

interface RetrievalResult {
  results: { docid: string; egressLineage?: EgressLineage }[];
  meta: { totalResults: number; collections?: string[] };
}

/**
 * Backstop after retrieval: drop any result whose document is not servable
 * (e.g. it changed since `provenanceRetrievalScope` ran), hide the
 * collection list the scope injected and name only readable collections in
 * each result's policy lineage.
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
      results.push(
        result.egressLineage
          ? {
              ...result,
              egressLineage: visibleEgressLineage(scope, result.egressLineage),
            }
          : result
      );
    }
  }
  const meta = { ...value.meta, totalResults: results.length };
  if (callerCollections === undefined) delete meta.collections;
  else meta.collections = callerCollections;
  return { ...value, results, meta } as T;
};
