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

export interface RerankOptions {
  /** Max candidates to rerank */
  maxCandidates?: number;
  /** Blending schedule */
  blendingSchedule?: BlendingTier[];
}

export interface RerankResult {
  candidates: RerankedCandidate[];
  reranked: boolean;
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

  // Group by document and pick best chunk per doc (highest fusionScore)
  // This is more efficient than full-doc reranking: 4K chunk vs 128K doc = 25x faster
  const MAX_CHUNK_CHARS = 4000;
  const bestChunkPerDoc = new Map<
    string,
    { candidate: FusionCandidate; seq: number }
  >();
  for (const c of toRerank) {
    const existing = bestChunkPerDoc.get(c.mirrorHash);
    if (!existing || c.fusionScore > existing.candidate.fusionScore) {
      bestChunkPerDoc.set(c.mirrorHash, { candidate: c, seq: c.seq });
    }
  }

  const uniqueHashes = [...bestChunkPerDoc.keys()];

  // Fetch chunks for each unique document (parallel)
  const chunkResults = await Promise.all(
    uniqueHashes.map((hash) => store.getChunks(hash))
  );

  // Build chunk text map: hash -> text of best chunk (truncated to 4K)
  const chunkTexts = new Map<string, string>();
  for (let i = 0; i < uniqueHashes.length; i++) {
    const hash = uniqueHashes[i] as string;
    const result = chunkResults[i];
    const bestInfo = bestChunkPerDoc.get(hash);

    if (result?.ok && result.value && bestInfo) {
      // Find chunk by seq number
      const chunk = result.value.find((c) => c.seq === bestInfo.seq);
      if (chunk) {
        const text = chunk.text;
        chunkTexts.set(
          hash,
          text.length > MAX_CHUNK_CHARS
            ? `${text.slice(0, MAX_CHUNK_CHARS)}...`
            : text
        );
      } else {
        chunkTexts.set(hash, '');
      }
    } else {
      chunkTexts.set(hash, '');
    }
  }

  // Build texts array for reranking (one chunk per unique document)
  const hashToIndex = new Map<string, number>();
  const texts: string[] = [];
  for (const hash of uniqueHashes) {
    hashToIndex.set(hash, texts.length);
    texts.push(chunkTexts.get(hash) ?? '');
  }

  // Run reranking on best chunks (much faster than full docs)
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
  // Build doc index->score map for O(1) lookup
  // All chunks from same document share the same rerank score
  const scoreByDocIndex = new Map(
    rerankResult.value.map((s) => [s.index, s.score])
  );

  // Normalize rerank scores using min-max (models return varying scales)
  const rerankScores = rerankResult.value.map((s) => s.score);
  const minRerank = Math.min(...rerankScores);
  const maxRerank = Math.max(...rerankScores);
  const rerankRange = maxRerank - minRerank;

  function normalizeRerankScore(score: number): number {
    if (rerankRange < 1e-9) {
      return 1; // All tied for best
    }
    return (score - minRerank) / rerankRange;
  }

  const rerankedCandidates: RerankedCandidate[] = toRerank.map((c, i) => {
    // Get document-level rerank score (shared by all chunks from same doc)
    const docIndex = hashToIndex.get(c.mirrorHash) ?? -1;
    const rerankScore = scoreByDocIndex.get(docIndex) ?? null;

    // Normalize rerank score to 0-1 range using min-max
    const normalizedRerankScore =
      rerankScore !== null ? normalizeRerankScore(rerankScore) : null;

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
