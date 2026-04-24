/**
 * Retrieval benchmark metric helpers.
 *
 * @module src/bench/metrics
 */

export interface RelevanceJudgment {
  docid: string;
  relevance: number;
}

export interface RetrievalMetrics {
  precisionAtK: number;
  recallAtK: number;
  f1AtK: number;
  mrr: number;
  ndcgAtK: number;
}

function round(value: number, places = 4): number {
  return Number(value.toFixed(places));
}

/**
 * Compute Precision@K: fraction of retrieved top-K docs that are relevant.
 */
export function computePrecision(
  output: string[],
  expected: string[],
  k: number
): number {
  if (k <= 0) {
    return 0;
  }
  const expectedSet = new Set(expected);
  const hits = output.slice(0, k).filter((docid) => expectedSet.has(docid));
  return hits.length / k;
}

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
 * Compute F1@K from precision and recall.
 */
export function computeF1(precision: number, recall: number): number {
  if (precision === 0 && recall === 0) {
    return 0;
  }
  return (2 * precision * recall) / (precision + recall);
}

/**
 * Compute nDCG@K: normalized discounted cumulative gain.
 */
export function computeNdcg(
  output: string[],
  judgments: RelevanceJudgment[],
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

/**
 * Compute Mean Reciprocal Rank (single-query form).
 * Returns reciprocal rank of first relevant hit in output.
 */
export function computeMrr(output: string[], expected: string[]): number {
  if (expected.length === 0) {
    return 1;
  }
  const expectedSet = new Set(expected);
  for (const [index, docid] of output.entries()) {
    if (expectedSet.has(docid)) {
      return 1 / (index + 1);
    }
  }
  return 0;
}

export function computeRetrievalMetrics(input: {
  output: string[];
  expected: string[];
  judgments: RelevanceJudgment[];
  k: number;
}): RetrievalMetrics {
  const precision = computePrecision(input.output, input.expected, input.k);
  const recall = computeRecall(input.output, input.expected, input.k);
  const judgmentSource =
    input.judgments.length > 0
      ? input.judgments
      : input.expected.map((docid) => ({ docid, relevance: 1 }));

  return {
    precisionAtK: round(precision),
    recallAtK: round(recall),
    f1AtK: round(computeF1(precision, recall)),
    mrr: round(computeMrr(input.output, input.expected)),
    ndcgAtK: round(computeNdcg(input.output, judgmentSource, input.k)),
  };
}

export function averageMetrics(metrics: RetrievalMetrics[]): RetrievalMetrics {
  const average = (values: number[]): number =>
    values.length === 0
      ? 0
      : values.reduce((sum, value) => sum + value, 0) / values.length;

  return {
    precisionAtK: round(average(metrics.map((m) => m.precisionAtK))),
    recallAtK: round(average(metrics.map((m) => m.recallAtK))),
    f1AtK: round(average(metrics.map((m) => m.f1AtK))),
    mrr: round(average(metrics.map((m) => m.mrr))),
    ndcgAtK: round(average(metrics.map((m) => m.ndcgAtK))),
  };
}
