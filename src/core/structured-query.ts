/**
 * Structured multi-line query document parsing.
 *
 * Pure parser used across CLI, API, MCP, SDK, and Web.
 *
 * @module src/core/structured-query
 */

import type { QueryModeInput } from "../pipeline/types";

export interface StructuredQueryError {
  line: number | null;
  message: string;
}

export interface StructuredQueryNormalization {
  query: string;
  queryModes: QueryModeInput[];
  usedStructuredQuerySyntax: boolean;
  derivedQuery: boolean;
}

export type StructuredQueryResult =
  | { ok: true; value: StructuredQueryNormalization }
  | { ok: false; error: StructuredQueryError };

const RECOGNIZED_MODE_PREFIXES = new Set(["term", "intent", "hyde"]);
const ANY_PREFIX_PATTERN = /^\s*([a-z][a-z0-9_-]*)\s*:\s*(.*)$/i;
const RECOGNIZED_PREFIX_PATTERN = /^\s*(term|intent|hyde)\s*:\s*(.*)$/i;

function buildError(
  message: string,
  line: number | null
): StructuredQueryResult {
  return { ok: false, error: { message, line } };
}

function trimNonBlankLines(query: string): string[] {
  return query.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

/**
 * Parse multi-line structured query syntax.
 *
 * Rules:
 * - single-line queries remain unchanged
 * - blank lines are ignored
 * - recognized typed lines: term:, intent:, hyde:
 * - if structured syntax is used, unknown prefix lines like foo:bar are rejected
 * - untyped lines contribute to the base query text
 * - if no untyped lines exist, base query is derived from term lines first, then intent lines
 * - hyde-only documents are rejected
 */
export function normalizeStructuredQueryInput(
  query: string,
  explicitQueryModes: QueryModeInput[] = []
): StructuredQueryResult {
  if (!query.includes("\n")) {
    return {
      ok: true,
      value: {
        query,
        queryModes: explicitQueryModes,
        usedStructuredQuerySyntax: false,
        derivedQuery: false,
      },
    };
  }

  const lines = trimNonBlankLines(query);
  if (lines.length === 0) {
    return {
      ok: true,
      value: {
        query,
        queryModes: explicitQueryModes,
        usedStructuredQuerySyntax: false,
        derivedQuery: false,
      },
    };
  }

  const hasRecognizedTypedLine = lines.some((line) => {
    const match = line.match(RECOGNIZED_PREFIX_PATTERN);
    return Boolean(match?.[1]);
  });

  if (!hasRecognizedTypedLine) {
    return {
      ok: true,
      value: {
        query,
        queryModes: explicitQueryModes,
        usedStructuredQuerySyntax: false,
        derivedQuery: false,
      },
    };
  }

  const queryModes: QueryModeInput[] = [];
  const bodyLines: string[] = [];
  let hydeCount = 0;

  for (const [index, line] of query.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const recognized = trimmed.match(RECOGNIZED_PREFIX_PATTERN);
    if (recognized) {
      const mode = recognized[1]?.toLowerCase() as QueryModeInput["mode"];
      const text = recognized[2]?.trim() ?? "";
      if (text.length === 0) {
        return buildError(
          `Structured query line ${index + 1} must contain non-empty text after ${mode}:`,
          index + 1
        );
      }
      if (mode === "hyde") {
        hydeCount += 1;
        if (hydeCount > 1) {
          return buildError(
            "Only one hyde line is allowed in a structured query document.",
            index + 1
          );
        }
      }
      queryModes.push({ mode, text });
      continue;
    }

    const prefixed = trimmed.match(ANY_PREFIX_PATTERN);
    if (prefixed?.[1]) {
      const prefix = prefixed[1].toLowerCase();
      if (!RECOGNIZED_MODE_PREFIXES.has(prefix)) {
        return buildError(
          `Unknown structured query line prefix "${prefix}:" on line ${index + 1}. Expected term:, intent:, or hyde:.`,
          index + 1
        );
      }
    }

    bodyLines.push(trimmed);
  }

  const combinedQueryModes = [...queryModes, ...explicitQueryModes];
  const totalHydeCount = combinedQueryModes.filter(
    (entry) => entry.mode === "hyde"
  ).length;
  if (totalHydeCount > 1) {
    return buildError(
      "Only one hyde entry is allowed across structured query syntax and explicit query modes.",
      null
    );
  }

  let normalizedQuery = bodyLines.join(" ").trim();
  let derivedQuery = false;

  if (!normalizedQuery) {
    const termQuery = queryModes
      .filter((entry) => entry.mode === "term")
      .map((entry) => entry.text)
      .join(" ")
      .trim();
    const intentQuery = queryModes
      .filter((entry) => entry.mode === "intent")
      .map((entry) => entry.text)
      .join(" ")
      .trim();

    normalizedQuery = termQuery || intentQuery;
    derivedQuery = normalizedQuery.length > 0;
  }

  if (!normalizedQuery) {
    return buildError(
      "Structured query documents must include at least one plain query line, term line, or intent line. hyde-only documents are not allowed.",
      null
    );
  }

  return {
    ok: true,
    value: {
      query: normalizedQuery,
      queryModes: combinedQueryModes,
      usedStructuredQuerySyntax: true,
      derivedQuery,
    },
  };
}

export function hasStructuredQuerySyntax(query: string): boolean {
  const result = normalizeStructuredQueryInput(query);
  return result.ok && result.value.usedStructuredQuerySyntax;
}
