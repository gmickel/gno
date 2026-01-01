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
// Chunk Text Extraction
// ─────────────────────────────────────────────────────────────────────────────

const MAX_CHUNK_CHARS = 4000;

interface BestChunkInfo {
  candidate: FusionCandidate;
  seq: number;
}

/**
 * Extract best chunk per document for efficient reranking.
 */
function selectBestChunks(
  toRerank: FusionCandidate[]
): Map<string, BestChunkInfo> {
  const bestChunkPerDoc = new Map<string, BestChunkInfo>();
  for (const c of toRerank) {
    const existing = bestChunkPerDoc.get(c.mirrorHash);
    if (!existing || c.fusionScore > existing.candidate.fusionScore) {
      bestChunkPerDoc.set(c.mirrorHash, { candidate: c, seq: c.seq });
    }
  }
  return bestChunkPerDoc;
}

/**
 * Fetch chunk texts for reranking.
 */
async function fetchChunkTexts(
  store: StorePort,
  bestChunkPerDoc: Map<string, BestChunkInfo>
): Promise<{ texts: string[]; hashToIndex: Map<string, number> }> {
  const uniqueHashes = [...bestChunkPerDoc.keys()];
  const chunkResults = await Promise.all(
    uniqueHashes.map((hash) => store.getChunks(hash))
  );

  const chunkTexts = new Map<string, string>();
  for (let i = 0; i < uniqueHashes.length; i++) {
    const hash = uniqueHashes[i] as string;
    const result = chunkResults[i];
    const bestInfo = bestChunkPerDoc.get(hash);

    if (result?.ok && result.value && bestInfo) {
      const chunk = result.value.find((c) => c.seq === bestInfo.seq);
      const text = chunk?.text ?? '';
      chunkTexts.set(
        hash,
        text.length > MAX_CHUNK_CHARS
          ? `${text.slice(0, MAX_CHUNK_CHARS)}...`
          : text
      );
    } else {
      chunkTexts.set(hash, '');
    }
  }

  const hashToIndex = new Map<string, number>();
  const texts: string[] = [];
  for (const hash of uniqueHashes) {
    hashToIndex.set(hash, texts.length);
    texts.push(chunkTexts.get(hash) ?? '');
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
    return { candidates: [], reranked: false };
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
    };
  }

  const toRerank = candidates.slice(0, maxCandidates);
  const remaining = candidates.slice(maxCandidates);

  // Extract best chunk per document for efficient reranking
  const bestChunkPerDoc = selectBestChunks(toRerank);
  const { texts, hashToIndex } = await fetchChunkTexts(store, bestChunkPerDoc);

  // Run reranking on best chunks (much faster than full docs)
  const rerankResult = await rerankPort.rerank(query, texts);

  if (!rerankResult.ok) {
    return {
      candidates: candidates.map((c) => ({
        ...c,
        rerankScore: null,
        blendedScore: normalizeFusionScore(c.fusionScore),
      })),
      reranked: false,
    };
  }

  // Normalize rerank scores using min-max
  const scoreByDocIndex = new Map(
    rerankResult.value.map((s) => [s.index, s.score])
  );
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
  const allCandidates: RerankedCandidate[] = [
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

  return { candidates: allCandidates, reranked: true };
}
