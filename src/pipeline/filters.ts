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
        doc.relPath,
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
