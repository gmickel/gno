/**
 * Legacy multilingual BM25 sanity lane.
 * Placeholder that records lexical degradation; not a semantic quality claim.
 *
 * Runs cross-language queries through document-level BM25 only. The separate
 * general-embedding benchmark owns vector/hybrid multilingual evidence.
 *
 * @module evals/multilingual.eval
 */

import { evalite } from "evalite";

import { searchBm25 } from "../src/pipeline/search";
import queriesJson from "./fixtures/queries.json";
import { getSharedEvalDb } from "./helpers/setup-db";

interface QueryData {
  id: string;
  query: string;
  language?: string;
  relevantDocs: string[];
  judgments: Array<{ docid: string; relevance: number }>;
  note?: string;
}

const queries = queriesJson as QueryData[];

// Filter to multilingual test cases only
const multilingualQueries = queries.filter((q) => q.id.startsWith("ml"));

evalite("Multilingual BM25 Baseline (Legacy)", {
  data: () =>
    multilingualQueries.map((q) => ({
      input: { query: q.query, id: q.id, note: q.note },
      expected: q.relevantDocs,
    })),

  task: async (input) => {
    const ctx = await getSharedEvalDb();

    // Cross-language lexical degradation is expected. This lane intentionally
    // does not invoke embeddings and cannot support semantic quality claims.
    const result = await searchBm25(ctx.adapter, input.query, {
      limit: 10,
      collection: "eval",
    });

    if (!result.ok) {
      return [];
    }

    return result.value.results.map((r) => r.source.relPath);
  },

  scorers: [
    {
      name: "Recall@5 (BM25 baseline)",
      description: "Cross-language recall - expected low without vectors",
      scorer: ({ output, expected }) => {
        // Compute recall@5 inline
        const k = 5;
        const topK = output.slice(0, k);
        const hits = expected.filter((docid: string) =>
          topK.includes(docid)
        ).length;
        const recallScore = expected.length > 0 ? hits / expected.length : 1;

        // Return actual score - low scores expected until vector search
        return {
          score: recallScore,
          metadata: {
            hits,
            total: expected.length,
            note: "Legacy BM25 baseline; semantic benchmark is separate",
          },
        };
      },
    },
  ],

  columns: ({ input, output }) => [
    { label: "ID", value: input.id },
    { label: "Query", value: input.query.slice(0, 25) },
    { label: "Note", value: input.note?.slice(0, 30) ?? "" },
    { label: "Found", value: output.slice(0, 2).join(", ") },
  ],
});
