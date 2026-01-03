/**
 * Vector search ranking evaluation.
 * Tests BM25 search quality with Recall@K and nDCG@K.
 *
 * Note: Currently tests BM25 only (vector search requires embeddings).
 * Vector search will be tested after embedding infrastructure is ready.
 *
 * @module evals/vsearch.eval
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
  note?: string;
}

const queries = queriesJson as QueryData[];

evalite("BM25 Search Ranking", {
  data: async () => {
    // Filter to non-multilingual queries for basic search test
    const basicQueries = queries.filter((q) => !q.id.startsWith("ml"));

    return basicQueries.map((q) => ({
      input: { query: q.query, id: q.id },
      expected: {
        relevantDocs: q.relevantDocs,
        judgments: q.judgments,
      },
    }));
  },

  task: async (input) => {
    const ctx = await getSharedEvalDb();
    const result = await searchBm25(ctx.adapter, input.query, {
      limit: 10,
      collection: "eval",
    });

    if (!result.ok) {
      return [];
    }

    // Return docids (relative paths)
    return result.value.results.map((r) => r.source.relPath);
  },

  scorers: [
    {
      name: "Recall@5",
      description: "Fraction of relevant docs in top 5",
      scorer: ({ output, expected }) => ({
        score: computeRecall(output, expected.relevantDocs, 5),
      }),
    },
    {
      name: "Recall@10",
      description: "Fraction of relevant docs in top 10",
      scorer: ({ output, expected }) => ({
        score: computeRecall(output, expected.relevantDocs, 10),
      }),
    },
    {
      name: "nDCG@10",
      description: "Ranking quality considering graded relevance",
      scorer: ({ output, expected }) => ({
        score: computeNdcg(output, expected.judgments, 10),
      }),
    },
  ],

  columns: ({ input, output }) => [
    { label: "ID", value: input.id },
    { label: "Query", value: input.query.slice(0, 30) },
    { label: "Top 3", value: output.slice(0, 3).join(", ") },
  ],
});
