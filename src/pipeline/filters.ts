/**
 * Shared query filter evaluation for live query assembly and diagnostics.
 *
 * @module src/pipeline/filters
 */

import type { ChunkRow, DocumentRow, StorePort } from "../store/types";
import type { HybridSearchOptions } from "./types";

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
