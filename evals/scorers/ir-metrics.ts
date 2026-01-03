/**
 * Information Retrieval metrics scorers for Evalite.
 * Custom scorers for Recall@K, nDCG@K, and latency budgets.
 *
 * @module evals/scorers/ir-metrics
 */

import { createScorer } from "evalite";

// ─────────────────────────────────────────────────────────────────────────────
// Pure Metric Functions (for inline scorers)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute Recall@K: fraction of relevant docs in top K results.
 */
export function computeRecall(
  output: string[],
  expected: string[],
  k: number
): number {
  if (expected.length === 0) return 1;
  const topK = output.slice(0, k);
  const hits = expected.filter((docid) => topK.includes(docid)).length;
  return hits / expected.length;
}

/**
 * Compute nDCG@K: normalized discounted cumulative gain.
 */
export function computeNdcg(
  output: string[],
  judgments: Array<{ docid: string; relevance: number }>,
  k: number
): number {
  if (judgments.length === 0) return 1;
  const relMap = new Map(judgments.map((j) => [j.docid, j.relevance]));
  const dcg = output.slice(0, k).reduce((sum, docid, i) => {
    const rel = relMap.get(docid) ?? 0;
    return sum + (2 ** rel - 1) / Math.log2(i + 2);
  }, 0);
  const idcg = [...judgments]
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, k)
    .reduce((sum, j, i) => sum + (2 ** j.relevance - 1) / Math.log2(i + 2), 0);
  return idcg > 0 ? dcg / idcg : 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Recall@K Scorer
// ─────────────────────────────────────────────────────────────────────────────

interface RecallInput {
  query: string;
}

type RecallOutput = string[]; // docids
type RecallExpected = string[]; // relevant docids

/**
 * Recall@K: Fraction of relevant docs retrieved in top K results.
 * Returns 1.0 if no relevant docs expected (vacuous truth).
 */
export const recallAtK = (k: number) =>
  createScorer<RecallInput, RecallOutput, RecallExpected>({
    name: `Recall@${k}`,
    description: `Fraction of relevant docs retrieved in top ${k} results`,
    scorer: ({ output, expected }) => {
      if (!expected || expected.length === 0) {
        return {
          score: 1,
          metadata: { k, hits: 0, total: 0, note: "no relevants" },
        };
      }
      const topK = output.slice(0, k);
      const hits = expected.filter((docid) => topK.includes(docid)).length;
      return {
        score: hits / expected.length,
        metadata: { k, hits, total: expected.length, topK },
      };
    },
  });

// ─────────────────────────────────────────────────────────────────────────────
// nDCG@K Scorer
// ─────────────────────────────────────────────────────────────────────────────

interface NdcgInput {
  query: string;
}

type NdcgOutput = string[]; // docids
type NdcgExpected = Array<{ docid: string; relevance: number }>;

/**
 * nDCG@K: Normalized Discounted Cumulative Gain at rank K.
 * Measures ranking quality considering graded relevance.
 */
export const ndcgAtK = (k: number) =>
  createScorer<NdcgInput, NdcgOutput, NdcgExpected>({
    name: `nDCG@${k}`,
    description: `Normalized Discounted Cumulative Gain at rank ${k}`,
    scorer: ({ output, expected }) => {
      if (!expected || expected.length === 0) {
        return {
          score: 1,
          metadata: { k, dcg: 0, idcg: 0, note: "no judgments" },
        };
      }

      const relevanceMap = new Map(expected.map((e) => [e.docid, e.relevance]));

      // DCG for actual ranking
      const dcg = output.slice(0, k).reduce((sum, docid, i) => {
        const rel = relevanceMap.get(docid) ?? 0;
        return sum + (2 ** rel - 1) / Math.log2(i + 2);
      }, 0);

      // Ideal DCG (sorted by relevance)
      const idcg = [...expected]
        .sort((a, b) => b.relevance - a.relevance)
        .slice(0, k)
        .reduce((sum, e, i) => {
          return sum + (2 ** e.relevance - 1) / Math.log2(i + 2);
        }, 0);

      const score = idcg > 0 ? dcg / idcg : 1;

      return {
        score,
        metadata: {
          k,
          dcg: Number(dcg.toFixed(4)),
          idcg: Number(idcg.toFixed(4)),
          actualRanking: output.slice(0, k),
        },
      };
    },
  });

// ─────────────────────────────────────────────────────────────────────────────
// Latency Budget Scorer
// ─────────────────────────────────────────────────────────────────────────────

interface LatencyOutput {
  result: unknown;
  durationMs: number;
}

/**
 * Latency budget scorer: Soft gate on execution time.
 * Returns 1.0 if within budget, degrades gracefully above.
 */
export const latencyBudget = (maxMs: number) =>
  createScorer<unknown, LatencyOutput, undefined>({
    name: `Latency<${maxMs}ms`,
    description: `Checks if task completed within ${maxMs}ms budget`,
    scorer: ({ output }) => {
      const withinBudget = output.durationMs <= maxMs;
      // Degrade gracefully: 50% score at 2x budget, 0% at 3x
      const score = withinBudget
        ? 1
        : Math.max(0, 1 - (output.durationMs - maxMs) / (maxMs * 2));

      return {
        score,
        metadata: {
          durationMs: Math.round(output.durationMs),
          maxMs,
          withinBudget,
        },
      };
    },
  });
