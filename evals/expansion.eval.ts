/**
 * Query expansion stability evaluation.
 * Tests that expansion produces valid schema output.
 *
 * Note: Actual LLM expansion requires model loading.
 * This eval uses mock expansion for schema validation testing.
 *
 * @module evals/expansion.eval
 */

import { evalite } from "evalite";

import queriesJson from "./fixtures/queries.json";
import {
  expansionSchemaValid,
  hasLexicalVariants,
  hasVectorVariants,
} from "./scorers/expansion-validity";

interface QueryData {
  id: string;
  query: string;
}

const queries = queriesJson as QueryData[];

/**
 * Mock expansion that produces valid schema output.
 * Real expansion would use the LLM adapter.
 */
function mockExpand(query: string): {
  lexicalQueries: string[];
  vectorQueries: string[];
  hyde?: string;
} {
  const words = query.split(/\s+/);

  // Generate lexical variants (synonyms, typos)
  const lexicalQueries = [
    query,
    words.length > 1 ? words.slice(0, -1).join(" ") : query,
    `"${query}"`, // Exact phrase
  ].slice(0, 3);

  // Generate semantic variants
  const vectorQueries = [query, `how to ${query}`, `what is ${query}`].slice(
    0,
    3
  );

  return {
    lexicalQueries,
    vectorQueries,
    hyde: `This document explains ${query} in detail, covering best practices and common patterns.`,
  };
}

evalite("Expansion Schema Validity", {
  data: () => {
    // Use subset for expansion testing
    const subset = queries.slice(0, 15);

    return subset.map((q) => ({
      input: q.query,
    }));
  },

  task: async (input) => {
    // Use mock expansion for schema testing
    // Real expansion would: return await expandQuery(input);
    return mockExpand(input);
  },

  scorers: [expansionSchemaValid, hasLexicalVariants, hasVectorVariants],

  columns: ({ input, output }) => [
    { label: "Query", value: input.slice(0, 30) },
    {
      label: "Lexical",
      value: output.lexicalQueries?.length?.toString() ?? "0",
    },
    { label: "Vector", value: output.vectorQueries?.length?.toString() ?? "0" },
  ],

  // Run multiple times to detect LLM variance (when using real expansion)
  trialCount: 1, // Set to 3 when using real LLM expansion
});
