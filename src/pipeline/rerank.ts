/**
 * Reranking and position-aware blending.
 * Uses RerankPort to reorder candidates.
 *
 * @module src/pipeline/rerank
 */

import type { RerankPort } from '../llm/types';
import type { StorePort } from '../store/types';
import type { BlendingTier, FusionCandidate, RerankedCandidate } from './types';
import { DEFAULT_BLENDING_SCHEDULE } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type RerankOptions = {
  /** Max candidates to rerank */
  maxCandidates?: number;
  /** Blending schedule */
  blendingSchedule?: BlendingTier[];
};

export type RerankResult = {
  candidates: RerankedCandidate[];
  reranked: boolean;
};

export type RerankDeps = {
  rerankPort: RerankPort | null;
  store: StorePort;
};

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
  // Early return for empty candidates
  if (candidates.length === 0) {
    return { candidates: [], reranked: false };
  }

  const { rerankPort, store } = deps;
  const maxCandidates = options.maxCandidates ?? 20;
  const schedule = options.blendingSchedule ?? DEFAULT_BLENDING_SCHEDULE;

  // Normalize fusion scores to 0-1 range across ALL candidates for stability.
  // This ensures blendedScore is always in [0,1] regardless of reranker availability.
  const fusionScoresAll = candidates.map((c) => c.fusionScore);
  const minFusionAll = Math.min(...fusionScoresAll);
  const maxFusionAll = Math.max(...fusionScoresAll);
  const fusionRangeAll = maxFusionAll - minFusionAll;

  function normalizeFusionScore(score: number): number {
    if (fusionRangeAll < 1e-9) {
      return 1; // tie for best
    }
    const v = (score - minFusionAll) / fusionRangeAll;
    return Math.max(0, Math.min(1, v));
  }

  // If no reranker, return candidates with normalized fusion scores
  if (!rerankPort) {
    return {
      candidates: candidates.map((c) => ({
        ...c,
        rerankScore: null,
        blendedScore: normalizeFusionScore(c.fusionScore),
      })),
      reranked: false,
    };
  }

  // Limit candidates for reranking
  const toRerank = candidates.slice(0, maxCandidates);
  const remaining = candidates.slice(maxCandidates);

  // Pre-fetch all chunks in one batch query (eliminates N+1)
  const uniqueHashes = [...new Set(toRerank.map((c) => c.mirrorHash))];
  const chunksMapResult = await store.getChunksBatch(uniqueHashes);

  // If chunk fetch fails, degrade gracefully (fusion-only)
  // Don't rerank on empty/missing texts - produces non-deterministic results
  if (!chunksMapResult.ok) {
    return {
      candidates: candidates.map((c) => ({
        ...c,
        rerankScore: null,
        blendedScore: normalizeFusionScore(c.fusionScore),
      })),
      reranked: false,
    };
  }
  const chunksMap = chunksMapResult.value;

  // Build texts array for reranking
  const texts: string[] = toRerank.map((c) => {
    const chunks = chunksMap.get(c.mirrorHash) ?? [];
    const chunk = chunks.find((ch) => ch.seq === c.seq);
    return chunk?.text ?? '';
  });

  // Run reranking
  const rerankResult = await rerankPort.rerank(query, texts);

  if (!rerankResult.ok) {
    // Graceful degradation - return normalized fusion scores
    return {
      candidates: candidates.map((c) => ({
        ...c,
        rerankScore: null,
        blendedScore: normalizeFusionScore(c.fusionScore),
      })),
      reranked: false,
    };
  }

  // Map rerank scores to candidates
  // Note: We use normalizeFusionScore defined above (across ALL candidates)
  // Build index->score map for O(1) lookup instead of O(n) find per candidate
  const scoreByIndex = new Map(
    rerankResult.value.map((s) => [s.index, s.score])
  );
  const rerankedCandidates: RerankedCandidate[] = toRerank.map((c, i) => {
    const rerankScore = scoreByIndex.get(i) ?? null;

    // Normalize rerank score to 0-1 range (models may return different scales)
    const normalizedRerankScore =
      rerankScore !== null ? Math.max(0, Math.min(1, rerankScore)) : null;

    // Calculate blended score using normalized fusion score
    const position = i + 1;
    const normalizedFusion = normalizeFusionScore(c.fusionScore);
    const blendedScore =
      normalizedRerankScore !== null
        ? blend(normalizedFusion, normalizedRerankScore, position, schedule)
        : normalizedFusion;

    return {
      ...c,
      rerankScore: normalizedRerankScore,
      blendedScore,
    };
  });

  // Add remaining candidates (not reranked)
  // These get normalized fusion scores with penalty but clamped to [0,1]
  const allCandidates: RerankedCandidate[] = [
    ...rerankedCandidates,
    ...remaining.map((c) => {
      const base = normalizeFusionScore(c.fusionScore);
      return {
        ...c,
        rerankScore: null,
        // Apply 0.5x penalty and clamp to [0,1]
        blendedScore: Math.max(0, Math.min(1, base * 0.5)),
      };
    }),
  ];

  // Sort by blended score
  allCandidates.sort((a, b) => {
    const scoreDiff = b.blendedScore - a.blendedScore;
    if (Math.abs(scoreDiff) > 1e-9) {
      return scoreDiff;
    }
    // Deterministic tie-breaking
    const aKey = `${a.mirrorHash}:${a.seq}`;
    const bKey = `${b.mirrorHash}:${b.seq}`;
    return aKey.localeCompare(bKey);
  });

  return {
    candidates: allCandidates,
    reranked: true,
  };
}
