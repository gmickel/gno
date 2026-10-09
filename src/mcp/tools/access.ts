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
import type { ReadableDocumentsCheck } from "../../pipeline/types";
import type {
  DocumentRow,
  StorePort,
  SupersessionOptions,
} from "../../store/types";
import type { ToolContext } from "../server";

import {
  createAccessHookSession,
  createDocumentAccessCheck,
  type AccessHookFetch,
  type DocumentAccessCheck,
} from "../../core/access-hook";
import {
  type AccessRequest,
  accessNotFound,
  accessRuleAdmitsWrite,
  authorizedCollectionNames,
  derivedFromIssue,
  hookCheckedAccessRefCollections,
  isAccessMode,
  provenanceKeyOf,
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
  /** Typed-metadata key holding a collection's sources. */
  provenanceKeyOf: (collection: string) => string;
  /**
   * Per-document access hook check; set only when `gateway.accessHook` is
   * configured. Retrieval drops documents it does not allow before graph
   * expansion, reranking and counts.
   */
  check?: DocumentAccessCheck;
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
  return scopeOf(ctx, names);
};

const scopeOf = (
  ctx: ToolContext,
  names: string[],
  check?: DocumentAccessCheck
): McpAccessScope => {
  const allowed = new Set(names);
  const keys = new Map(
    ctx.collections.map((c) => [c.name, provenanceKeyOf(c.access)])
  );
  return {
    collections: names,
    canRead: (name) => allowed.has(name),
    provenanceKeyOf: (name) => keys.get(name) ?? provenanceKeyOf(undefined),
    ...(check ? { check } : {}),
  };
};

/**
 * The request's access scope with the access hook applied, or null when the
 * request is not in access mode. Without `gateway.accessHook` this equals
 * `mcpAccessScope`. With it, the hook is asked once for the `accessRef`
 * collections this context may reach (allowed ones become readable) and the
 * returned scope carries a per-document `check`. Hook answers are cached for
 * the rest of this request only. Every hook call of the request carries the
 * same `request_id`: the asserted `GNO-Request-Id`, else a fresh UUID.
 */
export const resolveMcpAccess = async (
  ctx: ToolContext,
  fetchImpl?: AccessHookFetch
): Promise<McpAccessScope | null> => {
  const request = accessRequestOf(ctx);
  const base = mcpAccessScope(ctx);
  const hook = ctx.config.gateway?.accessHook;
  if (!base || !hook) return base;
  const session = createAccessHookSession(
    hook,
    {
      subject: request.subject?.id ?? "",
      ctx: request.subject?.context ?? "public_only",
      // The caller's turn id (GNO-Request-Id) when sent; else one per call.
      requestId: request.subject?.requestId ?? crypto.randomUUID(),
    },
    fetchImpl
  );
  const candidates = hookCheckedAccessRefCollections(ctx.collections, request);
  const refs = candidates.flatMap((collection) =>
    collection.access && "accessRef" in collection.access
      ? [collection.access.accessRef]
      : []
  );
  const allowedRefs = await session.allowed(refs);
  const admitted = new Set(
    candidates
      .filter(
        (collection) =>
          collection.access &&
          "accessRef" in collection.access &&
          allowedRefs.has(
            `${collection.access.accessRef.sys}:${collection.access.accessRef.ref}`
          )
      )
      .map((collection) => collection.name)
  );
  // Keep config order.
  const names = ctx.collections
    .map((collection) => collection.name)
    .filter((name) => base.canRead(name) || admitted.has(name));
  const readable = new Set(names);
  const keyed = scopeOf(ctx, names);
  return scopeOf(
    ctx,
    names,
    createDocumentAccessCheck({
      session,
      canRead: (name) => readable.has(name),
      provenanceKeyOf: keyed.provenanceKeyOf,
    })
  );
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
  derivedFromIssue(
    doc.typedMetadata,
    doc.metadataError,
    scope.provenanceKeyOf(doc.collection)
  ) === null;

/** Servable and, when an access hook is set, allowed by it. */
export const isDocumentAllowed = async (
  scope: McpAccessScope,
  doc: Parameters<typeof isDocumentServable>[1] & { id: number }
): Promise<boolean> => {
  if (!isDocumentServable(scope, doc)) return false;
  if (!scope.check) return true;
  return (await scope.check([doc])).has(doc.id);
};

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
  const keys = [...new Set(scope.collections.map(scope.provenanceKeyOf))];
  for (const name of scope.collections) {
    const docs = await store.listDocuments(name);
    if (!docs.ok) throw new Error(docs.error.message);
    for (const doc of docs.value) {
      if (!doc.active || doc.mirrorHash === null) continue;
      if (isDocumentServable(scope, doc)) servable.add(doc.mirrorHash);
      else if (
        !doc.metadataError &&
        // Present under some scope key (passes the presence filter) but not
        // servable under its own collection's key.
        keys.some(
          (key) => derivedFromIssue(doc.typedMetadata, null, key) !== "missing"
        )
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
  canFollow: async (uris) => {
    const readable = new Set<string>();
    for (const uri of uris) {
      const doc = await store.getDocumentByUri(uri);
      if (doc.ok && doc.value && isDocumentServable(scope, doc.value)) {
        readable.add(uri);
      }
    }
    return readable;
  },
});

/** The documents this scope may serve, for graph link resolution. */
export const readableDocuments =
  (scope: McpAccessScope): ReadableDocumentsCheck =>
  async (documents) =>
    new Set(
      documents
        .filter((doc) => isDocumentServable(scope, doc))
        .map((doc) => doc.id)
    );

/**
 * Retrieval options that confine one search, query or Context Capsule to the
 * scope: the provenance allowlist, the `supersededBy` filter, graph links
 * resolved over readable documents only, and response metadata that counts
 * only readable documents.
 */
export const accessRetrievalOptions = async (
  scope: McpAccessScope,
  store: Pick<StorePort, "listDocuments" | "getDocumentByUri">
): Promise<{
  retrievalScope?: { allowedMirrorHashes: string[] };
  supersession: SupersessionOptions;
  readable: ReadableDocumentsCheck;
  accessScoped: true;
}> => ({
  ...(await provenanceRetrievalScope(scope, store)),
  supersession: supersessionScope(scope, store),
  readable: readableDocuments(scope),
  accessScoped: true,
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
    filter: withDerivedFromRequired(
      args.filter,
      scope.collections.map(scope.provenanceKeyOf)
    ),
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
    if (doc.ok && doc.value && (await isDocumentAllowed(scope, doc.value))) {
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
