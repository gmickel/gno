/**
 * Reranking and position-aware blending.
 * Uses RerankPort to reorder candidates.
 *
 * @module src/pipeline/rerank
 */

import type { RerankPort } from "../llm/types";
import type { ChunkRow, StorePort } from "../store/types";
import type { BlendingTier, FusionCandidate, RerankedCandidate } from "./types";

import {
  buildIntentAwareRerankQuery,
  selectBestChunkForSteering,
} from "./intent";
import { DEFAULT_BLENDING_SCHEDULE } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface RerankOptions {
  /** Max candidates to rerank */
  maxCandidates?: number;
  /** Blending schedule */
  blendingSchedule?: BlendingTier[];
  /** Optional disambiguating context for reranking */
  intent?: string;
}

export interface RerankResult {
  candidates: RerankedCandidate[];
  reranked: boolean;
  fallbackReason: "none" | "disabled" | "error";
}

export interface RerankDeps {
  rerankPort: RerankPort | null;
  store: StorePort;
}

// ─────────────────────────────────────────────────────────────────────────────
// Blending
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get blending weights for a position.
 */
function getBlendingWeights(
  position: number,
  schedule: BlendingTier[]
): { fusionWeight: number; rerankWeight: number } {
  const tier = schedule.find((t) => position <= t.maxRank);
  if (tier) {
    return { fusionWeight: tier.fusionWeight, rerankWeight: tier.rerankWeight };
  }
  // Fallback to last tier
  const last = schedule.at(-1);
  return last
    ? { fusionWeight: last.fusionWeight, rerankWeight: last.rerankWeight }
    : { fusionWeight: 0.5, rerankWeight: 0.5 };
}

/**
 * Blend fusion and rerank scores.
 */
function blend(
  fusionScore: number,
  rerankScore: number,
  position: number,
  schedule: BlendingTier[]
): number {
  const { fusionWeight, rerankWeight } = getBlendingWeights(position, schedule);
  return fusionWeight * fusionScore + rerankWeight * rerankScore;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chunk Text Extraction
// ─────────────────────────────────────────────────────────────────────────────

const MAX_CHUNK_CHARS = 4000;
const PROTECT_BM25_TOP_RANK = 1;

function isProtectedLexicalTopHit(candidate: FusionCandidate): boolean {
  return (
    candidate.bm25Rank === PROTECT_BM25_TOP_RANK &&
    candidate.sources.includes("bm25")
  );
}

/**
 * Fetch chunk texts for reranking.
 */
async function fetchChunkTexts(
  store: StorePort,
  toRerank: FusionCandidate[],
  query: string,
  intent: string | undefined
): Promise<{ texts: string[]; hashToIndex: Map<string, number> }> {
  const uniqueHashes = [
    ...new Set(toRerank.map((candidate) => candidate.mirrorHash)),
  ];
  const chunksBatchResult = await store.getChunksBatch(uniqueHashes);
  const chunksByHash: Map<string, ChunkRow[]> = chunksBatchResult.ok
    ? chunksBatchResult.value
    : new Map();
  const preferredSeqByHash = new Map<string, number>();

  for (const candidate of toRerank) {
    const existingSeq = preferredSeqByHash.get(candidate.mirrorHash);
    if (existingSeq !== undefined) {
      const existingCandidate = toRerank.find(
        (entry) =>
          entry.mirrorHash === candidate.mirrorHash && entry.seq === existingSeq
      );
      if (
        existingCandidate &&
        existingCandidate.fusionScore >= candidate.fusionScore
      ) {
        continue;
      }
    }
    preferredSeqByHash.set(candidate.mirrorHash, candidate.seq);
  }

  const chunkTexts = new Map<string, string>();
  for (const hash of uniqueHashes) {
    const chunks = chunksByHash.get(hash);
    const bestChunk = selectBestChunkForSteering(chunks ?? [], query, intent, {
      preferredSeq: preferredSeqByHash.get(hash) ?? null,
      intentWeight: 0.5,
    });
    const text = bestChunk?.text ?? "";
    chunkTexts.set(
      hash,
      text.length > MAX_CHUNK_CHARS
        ? `${text.slice(0, MAX_CHUNK_CHARS)}...`
        : text
    );
  }

  const hashToIndex = new Map<string, number>();
  const texts: string[] = [];
  for (const hash of uniqueHashes) {
    hashToIndex.set(hash, texts.length);
    texts.push(chunkTexts.get(hash) ?? "");
  }

  return { texts, hashToIndex };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rerank Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rerank candidates using cross-encoder.
 * Falls back to fusion-only if reranking fails.
 */
export async function rerankCandidates(
  deps: RerankDeps,
  query: string,
  candidates: FusionCandidate[],
  options: RerankOptions = {}
): Promise<RerankResult> {
  if (candidates.length === 0) {
    return { candidates: [], reranked: false, fallbackReason: "none" };
  }

  const { rerankPort, store } = deps;
  const maxCandidates = options.maxCandidates ?? 20;
  const schedule = options.blendingSchedule ?? DEFAULT_BLENDING_SCHEDULE;

  // Normalize fusion scores to 0-1 range across ALL candidates for stability.
  const fusionScoresAll = candidates.map((c) => c.fusionScore);
  const minFusionAll = Math.min(...fusionScoresAll);
  const maxFusionAll = Math.max(...fusionScoresAll);
  const fusionRangeAll = maxFusionAll - minFusionAll;

  const normalizeFusionScore = (score: number): number => {
    if (fusionRangeAll < 1e-9) {
      return 1;
    }
    const v = (score - minFusionAll) / fusionRangeAll;
    return Math.max(0, Math.min(1, v));
  };

  // No reranker: return candidates with normalized fusion scores
  if (!rerankPort) {
    return {
      candidates: candidates.map((c) => ({
        ...c,
        rerankScore: null,
        blendedScore: normalizeFusionScore(c.fusionScore),
      })),
      reranked: false,
      fallbackReason: "disabled",
    };
  }

  const toRerank = candidates.slice(0, maxCandidates);
  const remaining = candidates.slice(maxCandidates);

  // Extract best chunk per document for efficient reranking
  const { texts, hashToIndex } = await fetchChunkTexts(
    store,
    toRerank,
    query,
    options.intent
  );

  const uniqueTexts: string[] = [];
  const docIndexToUniqueIndex = new Map<number, number>();
  const uniqueIndexToDocIndices = new Map<number, number[]>();
  const textToUniqueIndex = new Map<string, number>();

  for (const [docIndex, text] of texts.entries()) {
    const existingIndex = textToUniqueIndex.get(text);
    if (existingIndex !== undefined) {
      docIndexToUniqueIndex.set(docIndex, existingIndex);
      const mapped = uniqueIndexToDocIndices.get(existingIndex) ?? [];
      mapped.push(docIndex);
      uniqueIndexToDocIndices.set(existingIndex, mapped);
      continue;
    }

    const uniqueIndex = uniqueTexts.length;
    uniqueTexts.push(text);
    textToUniqueIndex.set(text, uniqueIndex);
    docIndexToUniqueIndex.set(docIndex, uniqueIndex);
    uniqueIndexToDocIndices.set(uniqueIndex, [docIndex]);
  }

  // Run reranking on best chunks (much faster than full docs)
  const rerankResult = await rerankPort.rerank(
    buildIntentAwareRerankQuery(query, options.intent),
    uniqueTexts
  );

  if (!rerankResult.ok) {
    return {
      candidates: candidates.map((c) => ({
        ...c,
        rerankScore: null,
        blendedScore: normalizeFusionScore(c.fusionScore),
      })),
      reranked: false,
      fallbackReason: "error",
    };
  }

  // Normalize rerank scores using min-max
  const scoreByDocIndex = new Map<number, number>();
  for (const score of rerankResult.value) {
    const docIndices = uniqueIndexToDocIndices.get(score.index) ?? [];
    for (const docIndex of docIndices) {
      scoreByDocIndex.set(docIndex, score.score);
    }
  }
  const rerankScores = rerankResult.value.map((s) => s.score);
  const minRerank = Math.min(...rerankScores);
  const maxRerank = Math.max(...rerankScores);
  const rerankRange = maxRerank - minRerank;

  const normalizeRerankScore = (score: number): number => {
    if (rerankRange < 1e-9) {
      return 1;
    }
    return (score - minRerank) / rerankRange;
  };

  // Build reranked candidates with blended scores
  const rerankedCandidates: RerankedCandidate[] = toRerank.map((c, i) => {
    const docIndex = hashToIndex.get(c.mirrorHash) ?? -1;
    const rerankScore = scoreByDocIndex.get(docIndex) ?? null;
    const normalizedRerankScore =
      rerankScore !== null ? normalizeRerankScore(rerankScore) : null;

    const position = i + 1;
    const normalizedFusion = normalizeFusionScore(c.fusionScore);
    const blendedScore =
      normalizedRerankScore !== null
        ? blend(normalizedFusion, normalizedRerankScore, position, schedule)
        : normalizedFusion;

    return { ...c, rerankScore: normalizedRerankScore, blendedScore };
  });

  // Add remaining candidates with penalty
  let allCandidates: RerankedCandidate[] = [
    ...rerankedCandidates,
    ...remaining.map((c) => ({
      ...c,
      rerankScore: null,
      blendedScore: Math.max(
        0,
        Math.min(1, normalizeFusionScore(c.fusionScore) * 0.5)
      ),
    })),
  ];

  // Sort by blended score with deterministic tie-breaking
  allCandidates.sort((a, b) => {
    const scoreDiff = b.blendedScore - a.blendedScore;
    if (Math.abs(scoreDiff) > 1e-9) {
      return scoreDiff;
    }
    return `${a.mirrorHash}:${a.seq}`.localeCompare(`${b.mirrorHash}:${b.seq}`);
  });

  // Guardrail: keep strong original lexical #1 at the top.
  // This avoids rerank-only demotions on clear exact-hit queries.
  const protectedTopHit = allCandidates.find(isProtectedLexicalTopHit);
  if (protectedTopHit && allCandidates[0] !== protectedTopHit) {
    allCandidates = [
      protectedTopHit,
      ...allCandidates.filter((candidate) => candidate !== protectedTopHit),
    ];
  }

  return { candidates: allCandidates, reranked: true, fallbackReason: "none" };
}
