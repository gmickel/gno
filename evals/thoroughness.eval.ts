/**
 * Thoroughness comparison evaluation.
 * Compares fast/balanced/thorough modes - stats only, no ordering assertion.
 *
 * This eval measures how ranking quality changes with search depth,
 * but doesn't gate on thorough > balanced > fast (that's aspirational).
 *
 * @module evals/thoroughness.eval
 */

import { evalite } from "evalite";

import { searchBm25 } from "../src/pipeline/search";
import queriesJson from "./fixtures/queries.json";
import { getSharedEvalDb } from "./helpers/setup-db";
import { computeNdcg, computeRecall } from "./scorers/ir-metrics";

interface QueryData {
  id: string;
  query: string;
  relevantDocs: string[];
  judgments: Array<{ docid: string; relevance: number }>;
}

const queries = queriesJson as QueryData[];

type ThoroughnessLevel = "fast" | "balanced" | "thorough";

// Latency budgets per level (ms)
const LATENCY_BUDGETS: Record<ThoroughnessLevel, number> = {
  fast: 200,
  balanced: 500,
  thorough: 2000,
};

/**
 * Simulate different thoroughness levels.
 * Currently all use BM25 - real implementation would:
 * - fast: BM25 only
 * - balanced: hybrid without expansion
 * - thorough: hybrid with expansion + rerank
 */
async function searchAtLevel(
  query: string,
  level: ThoroughnessLevel
): Promise<{ docids: string[]; durationMs: number }> {
  const ctx = await getSharedEvalDb();
  const start = performance.now();

  // For now, all levels use BM25
  // Differentiate by limit to simulate different depths
  const limits: Record<ThoroughnessLevel, number> = {
    fast: 5,
    balanced: 10,
    thorough: 20,
  };

  const result = await searchBm25(ctx.adapter, query, {
    limit: limits[level],
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
}

evalite("Thoroughness Comparison", {
  data: () => {
    // Create test cases for each query x level combination
    const subset = queries.slice(0, 8);
    const cases: Array<{
      input: { query: string; level: ThoroughnessLevel; id: string };
      expected: { relevantDocs: string[]; judgments: QueryData["judgments"] };
    }> = [];

    for (const q of subset) {
      for (const level of [
        "fast",
        "balanced",
        "thorough",
      ] as ThoroughnessLevel[]) {
        cases.push({
          input: { query: q.query, level, id: `${q.id}-${level}` },
          expected: { relevantDocs: q.relevantDocs, judgments: q.judgments },
        });
      }
    }

    return cases;
  },

  task: async (input) => searchAtLevel(input.query, input.level),

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
      name: "Latency Budget",
      description: "Within expected latency for thoroughness level",
      scorer: ({ input, output }) => {
        const budget = LATENCY_BUDGETS[input.level];
        const withinBudget = output.durationMs <= budget;
        const score = withinBudget
          ? 1
          : Math.max(0, 1 - (output.durationMs - budget) / (budget * 2));
        return {
          score,
          metadata: {
            durationMs: Math.round(output.durationMs),
            budget,
            withinBudget,
          },
        };
      },
    },
  ],

  columns: ({ input, output }) => [
    { label: "Query", value: input.query.slice(0, 20) },
    { label: "Level", value: input.level },
    { label: "Time", value: `${output.durationMs.toFixed(0)}ms` },
    { label: "Results", value: output.docids.length.toString() },
  ],
});
