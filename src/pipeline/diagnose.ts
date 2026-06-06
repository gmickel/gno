/**
 * Targeted query diagnostics.
 *
 * @module src/pipeline/diagnose
 */

import type { NormalizedContentTypeRule } from "../config";
import type { DocumentRow, StoreResult } from "../store/types";
import type { HybridSearchDeps } from "./hybrid";
import type {
  HybridSearchOptions,
  QueryModeSummary,
  QueryDiagnoseStageId,
  QueryDiagnoseTraceCandidate,
} from "./types";

import { fingerprintContentTypeRules } from "../config";
import { resolveDocRef } from "../core/ref-parser";
import { err, ok } from "../store/types";
import { evaluateQueryTargetFilters } from "./filters";
import { searchHybrid } from "./hybrid";

export type QueryDiagnoseTargetStatus =
  | "not_found"
  | "inactive"
  | "no_indexed_content"
  | "filtered_out"
  | "diagnosed";

export type QueryDiagnoseDropReason =
  | "not_in_candidate_set"
  | "below_cutoff"
  | "skipped"
  | null;

export interface QueryDiagnoseStage {
  id: QueryDiagnoseStageId;
  status: "active" | "skipped";
  sourceCount: number;
  present: boolean;
  rank: number | null;
  score: number | null;
  survived: boolean;
  dropReason: QueryDiagnoseDropReason;
  reason?: string;
}

export interface QueryDiagnoseResult {
  schemaVersion: "1.0";
  query: string;
  target: {
    ref: string;
    status: QueryDiagnoseTargetStatus;
    docid: string | null;
    uri: string | null;
    title: string | null;
    contentType: string | null;
    contentTypeSource: string | null;
    categories: string[];
    graphHints: string[];
    contentTypeRulesFingerprint: string | null;
    contentTypeFingerprintMatches: boolean | null;
    mirrorHash: string | null;
    chunkCount: number;
    filterReasons: string[];
  };
  stages: QueryDiagnoseStage[];
  chunk: {
    seq: number | null;
    startLine: number | null;
    endLine: number | null;
    language: string | null;
  };
  meta: {
    mode: "bm25_only" | "hybrid";
    vectorsUsed: boolean;
    reranked: boolean;
    totalResults: number;
    queryModes?: QueryModeSummary;
  };
}

export type QueryDiagnoseOptions = HybridSearchOptions & {
  target: string;
  contentTypeRules?: NormalizedContentTypeRule[];
  contentTypeRulesFingerprint?: string;
};

function graphHintsForDoc(
  doc: DocumentRow,
  rules: NormalizedContentTypeRule[]
): string[] {
  if (!doc.contentType) {
    return [];
  }
  return rules.find((rule) => rule.id === doc.contentType)?.graphHints ?? [];
}

function buildBaseResult(
  query: string,
  targetRef: string,
  status: QueryDiagnoseTargetStatus,
  doc: DocumentRow | null,
  fields: {
    graphHints?: string[];
    chunkCount?: number;
    filterReasons?: string[];
    fingerprint?: string | null;
    fingerprintMatches?: boolean | null;
  } = {}
): QueryDiagnoseResult {
  return {
    schemaVersion: "1.0",
    query,
    target: {
      ref: targetRef,
      status,
      docid: doc?.docid ?? null,
      uri: doc?.uri ?? null,
      title: doc?.title ?? null,
      contentType: doc?.contentType ?? null,
      contentTypeSource: doc?.contentTypeSource ?? null,
      categories: doc?.categories ?? [],
      graphHints: fields.graphHints ?? [],
      contentTypeRulesFingerprint: doc?.contentTypeRulesFingerprint ?? null,
      contentTypeFingerprintMatches: fields.fingerprintMatches ?? null,
      mirrorHash: doc?.mirrorHash ?? null,
      chunkCount: fields.chunkCount ?? 0,
      filterReasons: fields.filterReasons ?? [],
    },
    stages: [],
    chunk: {
      seq: null,
      startLine: null,
      endLine: null,
      language: null,
    },
    meta: {
      mode: "bm25_only",
      vectorsUsed: false,
      reranked: false,
      totalResults: 0,
    },
  };
}

function findTargetCandidate(
  candidates: QueryDiagnoseTraceCandidate[],
  mirrorHash: string,
  targetSeqs: Set<number>
): QueryDiagnoseTraceCandidate | undefined {
  return candidates.find(
    (candidate) =>
      candidate.mirrorHash === mirrorHash && targetSeqs.has(candidate.seq)
  );
}

export async function diagnoseQueryTarget(
  deps: HybridSearchDeps,
  query: string,
  options: QueryDiagnoseOptions
): Promise<StoreResult<QueryDiagnoseResult>> {
  const resolved = await resolveDocRef(deps.store, options.target);
  if ("error" in resolved) {
    return ok(buildBaseResult(query, options.target, "not_found", null));
  }

  const doc = resolved.doc;
  const rules = options.contentTypeRules ?? [];
  const expectedFingerprint =
    options.contentTypeRulesFingerprint ?? fingerprintContentTypeRules(rules);
  const fingerprintMatches = doc.contentTypeRulesFingerprint
    ? doc.contentTypeRulesFingerprint === expectedFingerprint
    : null;
  const graphHints = graphHintsForDoc(doc, rules);

  if (!doc.active) {
    return ok(
      buildBaseResult(query, options.target, "inactive", doc, {
        graphHints,
        fingerprintMatches,
      })
    );
  }
  if (!doc.mirrorHash) {
    return ok(
      buildBaseResult(query, options.target, "no_indexed_content", doc, {
        graphHints,
        fingerprintMatches,
      })
    );
  }

  const chunksResult = await deps.store.getChunks(doc.mirrorHash);
  if (!chunksResult.ok) {
    return err("QUERY_FAILED", chunksResult.error.message);
  }
  const chunks = chunksResult.value;
  if (chunks.length === 0) {
    return ok(
      buildBaseResult(query, options.target, "no_indexed_content", doc, {
        graphHints,
        fingerprintMatches,
      })
    );
  }

  const filterEval = await evaluateQueryTargetFilters(
    deps.store,
    query,
    doc,
    chunks,
    options
  );
  if (!filterEval.matches) {
    return ok(
      buildBaseResult(query, options.target, "filtered_out", doc, {
        graphHints,
        chunkCount: chunks.length,
        filterReasons: filterEval.reasons,
        fingerprintMatches,
      })
    );
  }

  const searchResult = await searchHybrid(deps, query, {
    ...options,
    diagnoseTrace: true,
  });
  if (!searchResult.ok) {
    return err(searchResult.error.code, searchResult.error.message);
  }

  const trace = searchResult.value.meta.trace;
  const targetSeqs = new Set(chunks.map((chunk) => chunk.seq));
  let seenEarlier = false;
  const stages: QueryDiagnoseStage[] =
    trace?.stages.map((stage) => {
      const candidate = findTargetCandidate(
        stage.candidates,
        doc.mirrorHash ?? "",
        targetSeqs
      );
      const present = Boolean(candidate);
      const dropReason: QueryDiagnoseDropReason =
        stage.status === "skipped"
          ? "skipped"
          : present
            ? null
            : seenEarlier
              ? "below_cutoff"
              : "not_in_candidate_set";
      if (present) {
        seenEarlier = true;
      }
      return {
        id: stage.id,
        status: stage.status,
        sourceCount: stage.sourceCount,
        present,
        rank: candidate?.rank ?? null,
        score: candidate?.score ?? null,
        survived: present,
        dropReason,
        reason: stage.reason,
      };
    }) ?? [];

  const firstMatched = trace?.stages
    .flatMap((stage) => stage.candidates)
    .find(
      (candidate) =>
        candidate.mirrorHash === doc.mirrorHash && targetSeqs.has(candidate.seq)
    );
  const matchedChunk =
    chunks.find((chunk) => chunk.seq === firstMatched?.seq) ??
    chunks[0] ??
    null;

  return ok({
    ...buildBaseResult(query, options.target, "diagnosed", doc, {
      graphHints,
      chunkCount: chunks.length,
      fingerprintMatches,
    }),
    stages,
    chunk: {
      seq: matchedChunk?.seq ?? null,
      startLine: matchedChunk?.startLine ?? null,
      endLine: matchedChunk?.endLine ?? null,
      language: matchedChunk?.language ?? null,
    },
    meta: {
      mode:
        searchResult.value.meta.mode === "bm25_only" ? "bm25_only" : "hybrid",
      vectorsUsed: searchResult.value.meta.vectorsUsed ?? false,
      reranked: searchResult.value.meta.reranked ?? false,
      totalResults: searchResult.value.meta.totalResults,
      queryModes: searchResult.value.meta.queryModes,
    },
  });
}
