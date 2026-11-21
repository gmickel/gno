/**
 * Shared query filter evaluation for live query assembly and diagnostics.
 *
 * @module src/pipeline/filters
 */

import type { ChunkRow, DocumentRow, StorePort, TagRow } from "../store/types";
import type { HybridSearchOptions } from "./types";

import {
  matchesMetadataPredicate,
  TYPED_METADATA_INGEST_VERSION,
  type MetadataPredicate,
} from "../core/typed-metadata";
import {
  compileExcludeTerms,
  matchesExcludedChunks,
  matchesExcludedText,
} from "./exclude";
import {
  compileTemporalRange,
  isWithinTemporalRange,
  resolveTemporalRange,
  type TemporalRange,
} from "./temporal";

export interface QueryFilterEvaluation {
  matches: boolean;
  reasons: string[];
}

export interface CompiledDocumentFilters {
  temporalRange: TemporalRange;
  authorLower?: string;
  allowedCategories?: Set<string>;
  excludeTermsLower?: string[];
  collection?: string;
  collectionsSet?: Set<string>;
  allowedMirrorHashSet?: Set<string>;
  callerCollection?: string;
  callerCollectionsSet?: Set<string>;
  callerAllowedMirrorHashSet?: Set<string>;
}

/** Pre-compile query-invariant filter sets and bounds once per search. */
export function compileDocumentFilters(
  query: string,
  options: Pick<
    HybridSearchOptions,
    | "since"
    | "until"
    | "author"
    | "categories"
    | "exclude"
    | "collection"
    | "collections"
    | "retrievalScope"
  >,
  callerScope?: Pick<
    HybridSearchOptions,
    "collection" | "collections" | "retrievalScope"
  >,
  preResolvedTemporal?: TemporalRange
): CompiledDocumentFilters {
  const temporalRange = compileTemporalRange(
    preResolvedTemporal ??
      resolveTemporalRange(query, options.since, options.until)
  );
  return {
    temporalRange,
    authorLower: options.author ? options.author.toLowerCase() : undefined,
    allowedCategories: options.categories?.length
      ? new Set(options.categories.map((c) => c.toLowerCase()))
      : undefined,
    excludeTermsLower: compileExcludeTerms(options.exclude),
    collection: options.collection,
    collectionsSet: options.collections
      ? new Set(options.collections)
      : undefined,
    allowedMirrorHashSet: options.retrievalScope
      ? new Set(options.retrievalScope.allowedMirrorHashes)
      : undefined,
    callerCollection: callerScope?.collection,
    callerCollectionsSet: callerScope?.collections
      ? new Set(callerScope.collections)
      : undefined,
    callerAllowedMirrorHashSet: callerScope?.retrievalScope
      ? new Set(callerScope.retrievalScope.allowedMirrorHashes)
      : undefined,
  };
}

/** Internal pre-budget contract. Undefined metadata is a failed lookup, never
 * an unrestricted candidate. Owners must be evaluated separately; this does
 * not replace complete ownership lineage or change ranking/deduplication.
 * Managed-memory scopes/supersession must already be enforced by the store.
 */
/** True when `collection` falls outside the request's collection scope. */
function outsideCollectionScope(
  scope: Pick<HybridSearchOptions, "collection" | "collections">,
  collection: string,
  collectionsSet?: Set<string>
): boolean {
  if (scope.collection && collection !== scope.collection) return true;
  if (collectionsSet !== undefined) return !collectionsSet.has(collection);
  return (
    scope.collections !== undefined && !scope.collections.includes(collection)
  );
}

export async function evaluateRetrievalEligibility(
  store: StorePort,
  query: string,
  doc: DocumentRow | undefined,
  chunks: ChunkRow[] | undefined,
  options: HybridSearchOptions,
  callerScope?: Pick<
    HybridSearchOptions,
    "collection" | "collections" | "retrievalScope"
  >,
  compiled?: CompiledDocumentFilters,
  prefetchedTags?: ReadonlyMap<number, TagRow[]> | null
): Promise<QueryFilterEvaluation & { chunks: ChunkRow[] }> {
  if (!doc || !chunks || !doc.mirrorHash) {
    return { matches: false, reasons: ["metadata"], chunks: [] };
  }
  const reasons: string[] = [];
  if (!doc.active) reasons.push("inactive");
  const sourcePath = doc.recordSourcePath ?? doc.relPath;
  const scopeEntries: Array<{
    scope:
      | Pick<
          HybridSearchOptions,
          "collection" | "collections" | "retrievalScope"
        >
      | undefined;
    collectionsSet?: Set<string>;
    allowedMirrorHashSet?: Set<string>;
  }> = [
    {
      scope: callerScope,
      collectionsSet: compiled?.callerCollectionsSet,
      allowedMirrorHashSet: compiled?.callerAllowedMirrorHashSet,
    },
    {
      scope: options,
      collectionsSet: compiled?.collectionsSet,
      allowedMirrorHashSet: compiled?.allowedMirrorHashSet,
    },
  ];
  for (const { scope, collectionsSet, allowedMirrorHashSet } of scopeEntries) {
    if (
      scope &&
      outsideCollectionScope(scope, doc.collection, collectionsSet)
    ) {
      reasons.push("collection");
    }
    if (scope?.retrievalScope) {
      const allowed = allowedMirrorHashSet
        ? allowedMirrorHashSet.has(doc.mirrorHash)
        : scope.retrievalScope.allowedMirrorHashes.includes(doc.mirrorHash);
      if (!allowed) {
        reasons.push("scope");
      }
      const prefix = scope.retrievalScope.relPathPrefix;
      if (
        prefix !== undefined &&
        sourcePath !== prefix &&
        !sourcePath.startsWith(`${prefix}/`)
      ) {
        reasons.push("path");
      }
    }
  }
  // Whole-document exclusions inspect every chunk before language selection.
  // A mismatched hash is incomplete/corrupt metadata, not a usable owner.
  if (chunks.some((chunk) => chunk.mirrorHash !== doc.mirrorHash)) {
    reasons.push("metadata");
  }
  if (reasons.length === 0) {
    try {
      reasons.push(
        ...(
          await evaluateQueryTargetFilters(
            store,
            query,
            doc,
            chunks,
            options,
            compiled,
            prefetchedTags
          )
        ).reasons
      );
    } catch {
      reasons.push("metadata");
    }
  }
  const eligibleChunks = chunks.filter(
    (chunk) => !options.lang || chunk.language === options.lang
  );
  return {
    matches: reasons.length === 0,
    reasons,
    chunks: reasons.length === 0 ? eligibleChunks : [],
  };
}

export function evaluateDocumentChunkFilters(
  query: string,
  doc: DocumentRow,
  chunks: ChunkRow[],
  options: HybridSearchOptions,
  compiled?: CompiledDocumentFilters
): QueryFilterEvaluation {
  const reasons: string[] = [];
  const metadataReason = typedMetadataFilterReason(doc, options.filter);
  if (metadataReason) reasons.push(metadataReason);
  const temporalRange =
    compiled?.temporalRange ??
    resolveTemporalRange(query, options.since, options.until);

  if (
    outsideCollectionScope(options, doc.collection, compiled?.collectionsSet)
  ) {
    reasons.push("collection");
  }
  if (!isWithinTemporalRange(doc.sourceMtime, temporalRange)) {
    reasons.push("date");
  }
  const authorLower =
    compiled !== undefined
      ? compiled.authorLower
      : options.author?.toLowerCase();
  if (authorLower && !doc.author?.toLowerCase().includes(authorLower)) {
    reasons.push("author");
  }
  const allowedCategories =
    compiled !== undefined
      ? compiled.allowedCategories
      : options.categories?.length
        ? new Set(options.categories.map((c) => c.toLowerCase()))
        : undefined;
  if (allowedCategories) {
    const contentTypeMatch = doc.contentType
      ? allowedCategories.has(doc.contentType.toLowerCase())
      : false;
    const categoryMatch = (doc.categories ?? []).some((c) =>
      allowedCategories.has(c.toLowerCase())
    );
    if (!contentTypeMatch && !categoryMatch) {
      reasons.push("category");
    }
  }
  if (
    options.lang &&
    !chunks.some((chunk) => chunk.language === options.lang)
  ) {
    reasons.push("lang");
  }
  const excludeTerms =
    compiled !== undefined ? compiled.excludeTermsLower : options.exclude;
  const preLowercased = compiled !== undefined;
  if (
    excludeTerms?.length &&
    (matchesExcludedText(
      [
        doc.title ?? "",
        doc.recordSourcePath ?? doc.relPath,
        doc.author ?? "",
        doc.contentType ?? "",
        ...(doc.categories ?? []),
      ],
      excludeTerms,
      preLowercased
    ) ||
      matchesExcludedChunks(chunks, excludeTerms, preLowercased))
  ) {
    reasons.push("exclude");
  }

  return {
    matches: reasons.length === 0,
    reasons,
  };
}

export async function evaluateQueryTargetFilters(
  store: StorePort,
  query: string,
  doc: DocumentRow,
  chunks: ChunkRow[],
  options: HybridSearchOptions,
  compiled?: CompiledDocumentFilters,
  prefetchedTags?: ReadonlyMap<number, TagRow[]> | null
): Promise<QueryFilterEvaluation> {
  const reasons = [
    ...evaluateDocumentChunkFilters(query, doc, chunks, options, compiled)
      .reasons,
  ];

  if (options.tagsAll?.length || options.tagsAny?.length) {
    let docTagRows: TagRow[] | null = null;
    if (prefetchedTags !== undefined) {
      if (prefetchedTags === null) {
        reasons.push("tags");
      } else {
        docTagRows = prefetchedTags.get(doc.id) ?? [];
      }
    } else {
      const tagsResult = await store.getTagsForDoc(doc.id);
      if (!tagsResult.ok) {
        reasons.push("tags");
      } else {
        docTagRows = tagsResult.value;
      }
    }
    if (docTagRows !== null) {
      const docTags = new Set(docTagRows.map((tag) => tag.tag));
      if (
        options.tagsAll?.length &&
        !options.tagsAll.every((tag) => docTags.has(tag))
      ) {
        reasons.push("tagsAll");
      }
      if (
        options.tagsAny?.length &&
        !options.tagsAny.some((tag) => docTags.has(tag))
      ) {
        reasons.push("tagsAny");
      }
    }
  }

  return {
    matches: reasons.length === 0,
    reasons,
  };
}

/** Invalid or unextracted documents are ineligible even for negated predicates. */
export function typedMetadataFilterReason(
  doc: DocumentRow,
  filter?: MetadataPredicate
): string | undefined {
  if (!filter) return undefined;
  if ((doc.ingestVersion ?? 0) < TYPED_METADATA_INGEST_VERSION)
    return "metadata_backfill";
  if (doc.metadataError || !doc.typedMetadata) return "metadata_invalid";
  return matchesMetadataPredicate(doc.typedMetadata, filter)
    ? undefined
    : "metadata_filter";
}

export async function typedMetadataWarnings(
  store: StorePort,
  query: string,
  options: HybridSearchOptions
): Promise<{ code: string; message: string }[] | undefined> {
  if (!options.filter) return undefined;
  const unknown = [
    {
      code: "METADATA_COVERAGE_UNKNOWN",
      message:
        "Typed metadata coverage could not be checked; filtered results may be incomplete.",
    },
  ];
  if (!store.getTypedMetadataCoverage) return unknown;
  const range = resolveTemporalRange(query, options.since, options.until);
  const result = await store.getTypedMetadataCoverage({
    collection: options.collection,
    collections: options.collections,
    relPathPrefix: options.retrievalScope?.relPathPrefix,
    allowedMirrorHashes: options.retrievalScope?.allowedMirrorHashes,
    chunkLanguage: options.lang,
    tagsAll: options.tagsAll,
    tagsAny: options.tagsAny,
    since: range.since,
    until: range.until,
    categories: options.categories,
    author: options.author,
    exclude: options.exclude,
    excludeMetadata: true,
    semanticMetadata: true,
    memoryScopesAny: options.memoryFilter?.scopes,
    excludeSuperseded: options.memoryFilter?.excludeSuperseded,
  });
  if (!result.ok) return unknown;
  return metadataCoverageWarnings(result.value, "query");
}

/** The coverage warning for documents a typed metadata filter had to skip. */
export function metadataCoverageWarnings(
  coverage: { pending: number; invalid: number },
  scope: "query" | "listing"
): { code: string; message: string }[] | undefined {
  const { pending, invalid } = coverage;
  return pending || invalid
    ? [
        {
          code: "METADATA_COVERAGE_INCOMPLETE",
          message: `Typed metadata coverage is incomplete: ${pending} documents need re-ingestion and ${invalid} have invalid metadata within the ${scope} scope.`,
        },
      ]
    : undefined;
}

/**
 * Keep the documents a typed metadata predicate matches, counting the ones it
 * could not judge (pending re-ingestion or invalid metadata) for the warning.
 */
export function filterDocumentsByMetadata<T extends DocumentRow>(
  docs: readonly T[],
  filter: MetadataPredicate
): { matches: T[]; pending: number; invalid: number } {
  const matches: T[] = [];
  let pending = 0;
  let invalid = 0;
  for (const doc of docs) {
    const reason = typedMetadataFilterReason(doc, filter);
    if (reason === undefined) matches.push(doc);
    else if (reason === "metadata_backfill") pending += 1;
    else if (reason === "metadata_invalid") invalid += 1;
  }
  return { matches, pending, invalid };
}
