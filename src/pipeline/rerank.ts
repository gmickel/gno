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

  // Dedupe by document - multiple chunks from same doc use single full-doc rerank
  const uniqueHashes = [...new Set(toRerank.map((c) => c.mirrorHash))];

  // Fetch full document content for each unique document (parallel)
  // Max 128K chars per doc to fit in reranker context
  const MAX_DOC_CHARS = 128_000;
  const contentResults = await Promise.all(
    uniqueHashes.map((hash) => store.getContent(hash))
  );
  const docContents = new Map<string, string>();
  for (let i = 0; i < uniqueHashes.length; i++) {
    const hash = uniqueHashes[i] as string;
    const result = contentResults[i] as Awaited<
      ReturnType<typeof store.getContent>
    >;
    if (result.ok && result.value) {
      const content = result.value;
      docContents.set(
        hash,
        content.length > MAX_DOC_CHARS
          ? `${content.slice(0, MAX_DOC_CHARS)}...`
          : content
      );
    } else {
      // Fallback to empty string if content not available
      docContents.set(hash, '');
    }
  }

  // Build texts array for reranking (one per unique document)
  const hashToIndex = new Map<string, number>();
  const texts: string[] = [];
  for (const hash of uniqueHashes) {
    hashToIndex.set(hash, texts.length);
    texts.push(docContents.get(hash) ?? '');
  }

  // Run reranking on full documents
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
