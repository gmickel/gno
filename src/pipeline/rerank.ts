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
  rerankPort: RerankPort | null,
  store: StorePort,
  query: string,
  candidates: FusionCandidate[],
  options: RerankOptions = {}
): Promise<RerankResult> {
  const maxCandidates = options.maxCandidates ?? 20;
  const schedule = options.blendingSchedule ?? DEFAULT_BLENDING_SCHEDULE;

  // If no reranker, return candidates as-is with null rerank scores
  if (!rerankPort) {
    return {
      candidates: candidates.map((c, i) => ({
        ...c,
        rerankScore: null,
        blendedScore: c.fusionScore,
      })),
      reranked: false,
    };
  }

  // Limit candidates for reranking
  const toRerank = candidates.slice(0, maxCandidates);
  const remaining = candidates.slice(maxCandidates);

  // Get chunk texts for reranking (with cache to avoid duplicate fetches)
  const texts: string[] = [];
  const chunksCache = new Map<
    string,
    Awaited<ReturnType<typeof store.getChunks>>
  >();

  for (const c of toRerank) {
    // Get or fetch chunks for this mirrorHash
    let chunksResult = chunksCache.get(c.mirrorHash);
    if (!chunksResult) {
      chunksResult = await store.getChunks(c.mirrorHash);
      chunksCache.set(c.mirrorHash, chunksResult);
    }

    if (chunksResult.ok) {
      const chunk = chunksResult.value.find((ch) => ch.seq === c.seq);
      texts.push(chunk?.text ?? '');
    } else {
      texts.push('');
    }
  }

  // Run reranking
  const rerankResult = await rerankPort.rerank(query, texts);

  if (!rerankResult.ok) {
    // Graceful degradation - return fusion scores only
    return {
      candidates: candidates.map((c) => ({
        ...c,
        rerankScore: null,
        blendedScore: c.fusionScore,
      })),
      reranked: false,
    };
  }

  // Normalize fusion scores to 0-1 range for blending compatibility
  // RRF scores are ~1/(k+rank) which is ~0.016 at best for k=60
  // We use min-max normalization across the candidate set
  const fusionScores = toRerank.map((c) => c.fusionScore);
  const minFusion = Math.min(...fusionScores);
  const maxFusion = Math.max(...fusionScores);
  const fusionRange = maxFusion - minFusion;

  function normalizeFusionScore(score: number): number {
    if (fusionRange < 1e-9) {
      return 0.5; // All same score, use midpoint
    }
    return (score - minFusion) / fusionRange;
  }

  // Map rerank scores to candidates
  const rerankScores = rerankResult.value;
  const rerankedCandidates: RerankedCandidate[] = toRerank.map((c, i) => {
    const score = rerankScores.find((s) => s.index === i);
    const rerankScore = score?.score ?? null;

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
  // These get normalized fusion scores but stay below reranked candidates
  const allCandidates: RerankedCandidate[] = [
    ...rerankedCandidates,
    ...remaining.map((c) => ({
      ...c,
      rerankScore: null,
      // Apply 0.5x penalty to remaining (they weren't good enough to rerank)
      blendedScore: normalizeFusionScore(c.fusionScore) * 0.5,
    })),
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
