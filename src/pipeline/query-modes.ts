/**
 * Structured query mode parsing and normalization.
 *
 * @module src/pipeline/query-modes
 */

import type {
  ExpansionResult,
  QueryMode,
  QueryModeInput,
  QueryModeSummary,
} from "./types";

import { err, ok, type StoreResult } from "../store/types";

const QUERY_MODE_ENTRY = /^\s*(term|intent|hyde)\s*:\s*([\s\S]*\S[\s\S]*)\s*$/i;

/**
 * Parse a single CLI/API query mode spec in `mode:text` form.
 */
export function parseQueryModeSpec(spec: string): StoreResult<QueryModeInput> {
  const match = spec.match(QUERY_MODE_ENTRY);
  if (!match) {
    return err(
      "INVALID_INPUT",
      `Invalid --query-mode value "${spec}". Expected "term:<text>", "intent:<text>", or "hyde:<text>".`
    );
  }

  const mode = match[1]?.toLowerCase() as QueryMode | undefined;
  const text = match[2]?.trim();
  if (!mode || !text) {
    return err(
      "INVALID_INPUT",
      `Invalid --query-mode value "${spec}". Expected non-empty text after mode prefix.`
    );
  }

  return ok({ mode, text });
}

/**
 * Parse and validate repeated query mode specs.
 */
export function parseQueryModeSpecs(
  specs: string[]
): StoreResult<QueryModeInput[]> {
  const parsed: QueryModeInput[] = [];
  let hydeCount = 0;

  for (const spec of specs) {
    const entry = parseQueryModeSpec(spec);
    if (!entry.ok) {
      return entry;
    }
    if (entry.value.mode === "hyde") {
      hydeCount += 1;
      if (hydeCount > 1) {
        return err(
          "INVALID_INPUT",
          "Only one hyde mode is allowed in structured query input."
        );
      }
    }
    parsed.push(entry.value);
  }

  return ok(parsed);
}

/**
 * Normalize and summarize query modes for metadata/explain.
 */
export function summarizeQueryModes(
  queryModes: QueryModeInput[]
): QueryModeSummary {
  const summary: QueryModeSummary = { term: 0, intent: 0, hyde: false };
  for (const entry of queryModes) {
    if (entry.mode === "term") {
      summary.term += 1;
    } else if (entry.mode === "intent") {
      summary.intent += 1;
    } else {
      summary.hyde = true;
    }
  }
  return summary;
}

/**
 * Convert structured query modes into ExpansionResult shape used by hybrid pipeline.
 */
export function buildExpansionFromQueryModes(
  queryModes: QueryModeInput[]
): ExpansionResult | null {
  if (queryModes.length === 0) {
    return null;
  }

  const lexicalQueries: string[] = [];
  const vectorQueries: string[] = [];
  let hyde: string | undefined;

  for (const entry of queryModes) {
    if (entry.mode === "term") {
      lexicalQueries.push(entry.text);
    } else if (entry.mode === "intent") {
      vectorQueries.push(entry.text);
    } else if (!hyde) {
      hyde = entry.text;
    }
  }

  // Preserve existing expansion constraints (max 5 lexical/vector variants).
  const result: ExpansionResult = {
    lexicalQueries: [...new Set(lexicalQueries)].slice(0, 5),
    vectorQueries: [...new Set(vectorQueries)].slice(0, 5),
  };

  if (hyde) {
    result.hyde = hyde;
  }

  return result;
}
