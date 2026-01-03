/**
 * Multilingual cross-language retrieval evaluation.
 * Placeholder that passes - per-language tables are future work.
 *
 * Tests that queries in one language can find docs in another
 * via semantic similarity (embeddings bridge language gap).
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

evalite("Multilingual Cross-Language Retrieval", {
  data: () =>
    multilingualQueries.map((q) => ({
      input: { query: q.query, id: q.id, note: q.note },
      expected: q.relevantDocs,
    })),

  task: async (input) => {
    const ctx = await getSharedEvalDb();

    // BM25 won't find cross-language matches well
    // This is expected - vector search would do better
    // For now, this is a placeholder that may score low
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
            note: "BM25 baseline - vector search will improve",
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
