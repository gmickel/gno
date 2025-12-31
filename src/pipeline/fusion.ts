/**
 * RRF (Reciprocal Rank Fusion) implementation.
 * Combines BM25 and vector search results.
 *
 * @module src/pipeline/fusion
 */

import type { FusionCandidate, FusionSource, RrfConfig } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Input for fusion - ranked results from a single source */
export interface RankedInput {
  source: FusionSource;
  results: Array<{
    mirrorHash: string;
    seq: number;
    rank: number; // 1-based rank
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// RRF Score Calculation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate RRF contribution for a single rank.
 * Formula: weight / (k + rank)
 */
function rrfContribution(rank: number, k: number, weight: number): number {
  return weight / (k + rank);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fusion Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fuse multiple ranked lists using RRF.
 *
 * @param inputs - Array of ranked inputs from different sources
 * @param config - RRF configuration
 * @returns Fused and sorted candidates
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: RRF fusion with deduplication and scoring
export function rrfFuse(
  inputs: RankedInput[],
  config: RrfConfig
): FusionCandidate[] {
  // Map: "mirrorHash:seq" -> FusionCandidate
  const candidates = new Map<string, FusionCandidate>();

  // Separate inputs by type for weight assignment
  const bm25Inputs = inputs.filter(
    (i) => i.source === 'bm25' || i.source === 'bm25_variant'
  );
  const vectorInputs = inputs.filter(
    (i) =>
      i.source === 'vector' ||
      i.source === 'vector_variant' ||
      i.source === 'hyde'
  );

  // Process BM25 sources
  for (const input of bm25Inputs) {
    const weight =
      input.source === 'bm25' ? config.bm25Weight : config.bm25Weight * 0.5;

    for (const result of input.results) {
      const key = `${result.mirrorHash}:${result.seq}`;
      let candidate = candidates.get(key);

      if (!candidate) {
        candidate = {
          mirrorHash: result.mirrorHash,
          seq: result.seq,
          bm25Rank: null,
          vecRank: null,
          fusionScore: 0,
          sources: [],
        };
        candidates.set(key, candidate);
      }

      // Track best BM25 rank
      if (candidate.bm25Rank === null || result.rank < candidate.bm25Rank) {
        candidate.bm25Rank = result.rank;
      }

      // Add RRF contribution
      candidate.fusionScore += rrfContribution(result.rank, config.k, weight);
      if (!candidate.sources.includes(input.source)) {
        candidate.sources.push(input.source);
      }
    }
  }

  // Process vector sources
  for (const input of vectorInputs) {
    let weight = config.vecWeight;
    if (input.source === 'vector_variant') {
      weight = config.vecWeight * 0.5;
    } else if (input.source === 'hyde') {
      weight = config.vecWeight * 0.7;
    }

    for (const result of input.results) {
      const key = `${result.mirrorHash}:${result.seq}`;
      let candidate = candidates.get(key);

      if (!candidate) {
        candidate = {
          mirrorHash: result.mirrorHash,
          seq: result.seq,
          bm25Rank: null,
          vecRank: null,
          fusionScore: 0,
          sources: [],
        };
        candidates.set(key, candidate);
      }

      // Track best vector rank
      if (candidate.vecRank === null || result.rank < candidate.vecRank) {
        candidate.vecRank = result.rank;
      }

      // Add RRF contribution
      candidate.fusionScore += rrfContribution(result.rank, config.k, weight);
      if (!candidate.sources.includes(input.source)) {
        candidate.sources.push(input.source);
      }
    }
  }

  // Apply top-rank bonus
  for (const candidate of candidates.values()) {
    if (
      candidate.bm25Rank !== null &&
      candidate.bm25Rank <= config.topRankThreshold &&
      candidate.vecRank !== null &&
      candidate.vecRank <= config.topRankThreshold
    ) {
      candidate.fusionScore += config.topRankBonus;
    }
  }

  // Sort by fusion score (descending), then by mirrorHash:seq for determinism
  const sorted = Array.from(candidates.values()).sort((a, b) => {
    const scoreDiff = b.fusionScore - a.fusionScore;
    if (Math.abs(scoreDiff) > 1e-9) {
      return scoreDiff;
    }
    // Deterministic tie-breaking
    const aKey = `${a.mirrorHash}:${a.seq}`;
    const bKey = `${b.mirrorHash}:${b.seq}`;
    return aKey.localeCompare(bKey);
  });

  return sorted;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Convert search results to ranked input
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert array of (mirrorHash, seq) tuples to RankedInput.
 * Results are assumed to be in rank order (first = rank 1).
 */
export function toRankedInput(
  source: FusionSource,
  results: Array<{ mirrorHash: string; seq: number }>
): RankedInput {
  return {
    source,
    results: results.map((r, i) => ({
      mirrorHash: r.mirrorHash,
      seq: r.seq,
      rank: i + 1,
    })),
  };
}
