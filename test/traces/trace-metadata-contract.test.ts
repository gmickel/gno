import { describe, expect, test } from "bun:test";

import type { RetrievalTraceSession } from "../../src/core/retrieval-trace-session";
import type {
  Citation,
  SearchResult,
  SearchResults,
} from "../../src/pipeline/types";

import {
  attachRetrievalTraceMetadata,
  RETRIEVAL_TRACE_METADATA,
} from "../../src/core/retrieval-trace-session";
import {
  attachCitationTraceMetadata,
  attachSearchResultPlannerMetadata,
  attachSearchResultsTraceMetadata,
} from "../../src/pipeline/trace-metadata";
import {
  CITATION_TRACE_METADATA,
  SEARCH_RESULT_PLANNER_METADATA,
  SEARCH_RESULTS_TRACE_METADATA,
} from "../../src/pipeline/types";

const HASH = "a".repeat(64);

const descriptor = (value: object, key: symbol): PropertyDescriptor => {
  const found = Object.getOwnPropertyDescriptor(value, key);
  if (!found) throw new Error("Expected hidden retrieval metadata");
  return found;
};

describe("retrieval trace metadata transport contract", () => {
  test("keeps every internal metadata seam non-enumerable and non-canonical", () => {
    const result: SearchResult = {
      docid: "#abcdef",
      score: 1,
      uri: "gno://notes/evidence.md",
      snippet: "evidence",
      source: {
        relPath: "evidence.md",
        mime: "text/markdown",
        ext: ".md",
        sourceHash: HASH,
      },
      conversion: { mirrorHash: HASH },
    };
    const resultJson = JSON.stringify(result);
    attachSearchResultPlannerMetadata(result, {
      retrievalRank: 1,
      mirrorHash: HASH,
      seq: 0,
      sources: ["bm25"],
      graphExpanded: false,
      startLine: 1,
      endLine: 1,
      passageHash: HASH,
    });

    const results: SearchResults = {
      results: [result],
      meta: {
        query: "evidence",
        mode: "bm25",
        totalResults: 1,
      },
    };
    const resultsJson = JSON.stringify(results);
    attachSearchResultsTraceMetadata(results, {
      capabilityOutcomes: [{ capability: "lexical_search", status: "used" }],
      fallbackCodes: [],
    });

    const citation: Citation = {
      docid: "#abcdef",
      uri: "gno://notes/evidence.md",
      startLine: 1,
      endLine: 1,
    };
    const citationJson = JSON.stringify(citation);
    attachCitationTraceMetadata(citation, {
      sourceHash: HASH,
      mirrorHash: HASH,
      passageHash: HASH,
      rank: 1,
    });

    const envelope = { results: [] };
    const envelopeJson = JSON.stringify(envelope);
    attachRetrievalTraceMetadata(envelope, {
      metadata: () => ({ traceId: "trace-hidden" }),
    } as unknown as RetrievalTraceSession);

    for (const [value, key] of [
      [result, SEARCH_RESULT_PLANNER_METADATA],
      [results, SEARCH_RESULTS_TRACE_METADATA],
      [citation, CITATION_TRACE_METADATA],
      [envelope, RETRIEVAL_TRACE_METADATA],
    ] as const) {
      expect(descriptor(value, key)).toMatchObject({
        configurable: false,
        enumerable: false,
        writable: false,
      });
      expect(Reflect.ownKeys({ ...value })).not.toContain(key);
    }
    expect(JSON.stringify(result)).toBe(resultJson);
    expect(JSON.stringify(results)).toBe(resultsJson);
    expect(JSON.stringify(citation)).toBe(citationJson);
    expect(JSON.stringify(envelope)).toBe(envelopeJson);
  });
});
