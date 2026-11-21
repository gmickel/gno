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

export function compileExcludeTerms(
  excludeTerms: string[] | undefined
): string[] | undefined {
  if (!excludeTerms?.length) {
    return undefined;
  }
  return excludeTerms.map((term) => term.toLowerCase());
}

export function matchesExcludedText(
  haystacks: string[],
  excludeTerms: string[] | undefined,
  preLowercased = false
): boolean {
  if (!excludeTerms?.length) {
    return false;
  }
  const lowerTerms = preLowercased
    ? excludeTerms
    : excludeTerms.map((term) => term.toLowerCase());

  for (const haystack of haystacks) {
    if (!haystack) {
      continue;
    }
    const lowerHaystack = haystack.toLowerCase();
    for (const term of lowerTerms) {
      if (lowerHaystack.includes(term)) {
        return true;
      }
    }
  }

  return false;
}

export function matchesExcludedChunks(
  chunks: readonly ChunkRow[],
  excludeTerms: string[] | undefined,
  preLowercased = false
): boolean {
  if (!excludeTerms?.length || chunks.length === 0) {
    return false;
  }
  const lowerTerms = preLowercased
    ? excludeTerms
    : excludeTerms.map((term) => term.toLowerCase());

  for (const chunk of chunks) {
    if (!chunk.text) {
      continue;
    }
    const lowerText = chunk.text.toLowerCase();
    for (const term of lowerTerms) {
      if (lowerText.includes(term)) {
        return true;
      }
    }
  }

  return false;
}
