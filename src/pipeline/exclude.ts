/**
 * Explicit exclusion helpers for retrieval filters.
 *
 * @module src/pipeline/exclude
 */

import type { ChunkRow } from "../store/types";

export function normalizeExcludeTerms(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    for (const part of value.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) {
        continue;
      }
      const key = trimmed.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(trimmed);
    }
  }

  return out;
}

function includesTerm(haystack: string, term: string): boolean {
  return haystack.toLowerCase().includes(term.toLowerCase());
}

export function matchesExcludedText(
  haystacks: string[],
  excludeTerms: string[] | undefined
): boolean {
  if (!excludeTerms?.length) {
    return false;
  }

  for (const haystack of haystacks) {
    if (!haystack) {
      continue;
    }
    for (const term of excludeTerms) {
      if (includesTerm(haystack, term)) {
        return true;
      }
    }
  }

  return false;
}

export function matchesExcludedChunks(
  chunks: ChunkRow[],
  excludeTerms: string[] | undefined
): boolean {
  if (!excludeTerms?.length || chunks.length === 0) {
    return false;
  }

  return matchesExcludedText(
    chunks.map((chunk) => chunk.text),
    excludeTerms
  );
}
