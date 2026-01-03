/**
 * Hybrid query pipeline evaluation.
 * Tests BM25 search with latency tracking.
 *
 * Note: Full hybrid search (with vectors) requires embedding infrastructure.
 * This eval focuses on BM25 + latency baseline.
 *
 * @module evals/query.eval
 */

import { evalite } from "evalite";

import { searchBm25 } from "../src/pipeline/search";
import queriesJson from "./fixtures/queries.json";
import { getSharedEvalDb } from "./helpers/setup-db";
import { computeNdcg, computeRecall } from "./scorers/ir-metrics";

interface QueryData {
  id: string;
  query: string;
  language?: string;
  relevantDocs: string[];
  judgments: Array<{ docid: string; relevance: number }>;
}

const queries = queriesJson as QueryData[];

// Latency budget for BM25-only search (ms)
const BM25_LATENCY_BUDGET = 500;

evalite("Query Pipeline", {
  data: async () => {
    // Use subset for latency testing
    const subset = queries.slice(0, 10);

    return subset.map((q) => ({
      input: { query: q.query, id: q.id },
      expected: {
        relevantDocs: q.relevantDocs,
        judgments: q.judgments,
      },
    }));
  },

  task: async (input) => {
    const ctx = await getSharedEvalDb();

    const start = performance.now();
    const result = await searchBm25(ctx.adapter, input.query, {
      limit: 10,
      collection: "eval",
    });
    const durationMs = performance.now() - start;

    if (!result.ok) {
      return { docids: [], durationMs };
    }

    return {
      docids: result.value.results.map((r) => r.source.relPath),
      durationMs,
    };
  },

  scorers: [
    {
      name: "Recall@5",
      scorer: ({ output, expected }) => ({
        score: computeRecall(output.docids, expected.relevantDocs, 5),
      }),
    },
    {
      name: "nDCG@10",
      scorer: ({ output, expected }) => ({
        score: computeNdcg(output.docids, expected.judgments, 10),
      }),
    },
    {
      name: `Latency<${BM25_LATENCY_BUDGET}ms`,
      scorer: ({ output }) => {
        const withinBudget = output.durationMs <= BM25_LATENCY_BUDGET;
        const score = withinBudget
          ? 1
          : Math.max(
              0,
              1 -
                (output.durationMs - BM25_LATENCY_BUDGET) /
                  (BM25_LATENCY_BUDGET * 2)
            );
        return {
          score,
          metadata: {
            durationMs: Math.round(output.durationMs),
            budget: BM25_LATENCY_BUDGET,
            withinBudget,
          },
        };
      },
    },
  ],

  columns: ({ input, output }) => [
    { label: "Query", value: input.query.slice(0, 25) },
    { label: "Time", value: `${output.durationMs.toFixed(0)}ms` },
    { label: "Results", value: output.docids.length.toString() },
  ],

  // Deterministic for same DB state
  trialCount: 1,
});
