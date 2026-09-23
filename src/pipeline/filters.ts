import type { ChunkRow, DocumentRow, StorePort } from "../store/types";
/**
 * Shared query filter evaluation for live query assembly and diagnostics.
 *
 * @module src/pipeline/filters
 */
import type { HybridSearchOptions } from "./types";

import {
  matchesMetadataPredicate,
  TYPED_METADATA_INGEST_VERSION,
  type MetadataPredicate,
} from "../core/typed-metadata";
import { matchesExcludedChunks, matchesExcludedText } from "./exclude";
import { isWithinTemporalRange, resolveTemporalRange } from "./temporal";

export interface QueryFilterEvaluation {
  matches: boolean;
  reasons: string[];
}

/** Internal pre-budget contract. Undefined metadata is a failed lookup, never
 * an unrestricted candidate. Owners must be evaluated separately; this does
 * not replace complete ownership lineage or change ranking/deduplication.
 * Managed-memory scopes/supersession must already be enforced by the store.
 */
export async function evaluateRetrievalEligibility(
  store: StorePort,
  query: string,
  doc: DocumentRow | undefined,
  chunks: ChunkRow[] | undefined,
  options: HybridSearchOptions,
  callerScope?: Pick<HybridSearchOptions, "collection" | "retrievalScope">
): Promise<QueryFilterEvaluation & { chunks: ChunkRow[] }> {
  if (!doc || !chunks || !doc.mirrorHash) {
    return { matches: false, reasons: ["metadata"], chunks: [] };
  }
  const reasons: string[] = [];
  if (!doc.active) reasons.push("inactive");
  const sourcePath = doc.recordSourcePath ?? doc.relPath;
  for (const scope of [callerScope, options]) {
    if (scope?.collection && doc.collection !== scope.collection) {
      reasons.push("collection");
    }
    if (scope?.retrievalScope) {
      if (!scope.retrievalScope.allowedMirrorHashes.includes(doc.mirrorHash)) {
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
          await evaluateQueryTargetFilters(store, query, doc, chunks, options)
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
  options: HybridSearchOptions
): QueryFilterEvaluation {
  const reasons: string[] = [];
  const metadataReason = typedMetadataFilterReason(doc, options.filter);
  if (metadataReason) reasons.push(metadataReason);
  const temporalRange = resolveTemporalRange(
    query,
    options.since,
    options.until
  );

  if (options.collection && doc.collection !== options.collection) {
    reasons.push("collection");
  }
  if (!isWithinTemporalRange(doc.sourceMtime, temporalRange)) {
    reasons.push("date");
  }
  if (
    options.author &&
    !doc.author?.toLowerCase().includes(options.author.toLowerCase())
  ) {
    reasons.push("author");
  }
  if (options.categories?.length) {
    const allowed = new Set(options.categories.map((c) => c.toLowerCase()));
    const contentTypeMatch = doc.contentType
      ? allowed.has(doc.contentType.toLowerCase())
      : false;
    const categoryMatch = (doc.categories ?? []).some((c) =>
      allowed.has(c.toLowerCase())
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
  if (
    matchesExcludedText(
      [
        doc.title ?? "",
        doc.recordSourcePath ?? doc.relPath,
        doc.author ?? "",
        doc.contentType ?? "",
        ...(doc.categories ?? []),
      ],
      options.exclude
    ) ||
    matchesExcludedChunks(chunks, options.exclude)
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
  options: HybridSearchOptions
): Promise<QueryFilterEvaluation> {
  const reasons = [
    ...evaluateDocumentChunkFilters(query, doc, chunks, options).reasons,
  ];

  if (options.tagsAll?.length || options.tagsAny?.length) {
    const tagsResult = await store.getTagsForDoc(doc.id);
    if (!tagsResult.ok) {
      reasons.push("tags");
    } else {
      const docTags = new Set(tagsResult.value.map((tag) => tag.tag));
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
  const { pending, invalid } = result.value;
  return pending || invalid
    ? [
        {
          code: "METADATA_COVERAGE_INCOMPLETE",
          message: `Typed metadata coverage is incomplete: ${pending} documents need re-ingestion and ${invalid} have invalid metadata within the query scope.`,
        },
      ]
    : undefined;
}
