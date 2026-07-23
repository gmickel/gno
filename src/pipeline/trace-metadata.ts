/** Non-canonical retrieval metadata attached without changing public payloads. */

import type {
  Citation,
  CitationTraceMetadata,
  SearchResult,
  SearchResultPlannerMetadata,
  SearchResults,
  SearchResultsTraceMetadata,
} from "./types";

import {
  CITATION_TRACE_METADATA,
  SEARCH_RESULT_PLANNER_METADATA,
  SEARCH_RESULTS_TRACE_METADATA,
} from "./types";

const attachHiddenMetadata = <Value extends object, Metadata>(
  value: Value,
  key: symbol,
  metadata: Metadata
): Value => {
  Object.defineProperty(value, key, {
    configurable: false,
    enumerable: false,
    value: metadata,
    writable: false,
  });
  return value;
};

export const attachSearchResultPlannerMetadata = <Result extends SearchResult>(
  result: Result,
  metadata: SearchResultPlannerMetadata
): Result =>
  attachHiddenMetadata(result, SEARCH_RESULT_PLANNER_METADATA, metadata);

export const attachCitationTraceMetadata = <Result extends Citation>(
  citation: Result,
  metadata: CitationTraceMetadata
): Result => attachHiddenMetadata(citation, CITATION_TRACE_METADATA, metadata);

export const attachSearchResultsTraceMetadata = <Result extends SearchResults>(
  results: Result,
  metadata: SearchResultsTraceMetadata
): Result =>
  attachHiddenMetadata(results, SEARCH_RESULTS_TRACE_METADATA, metadata);
