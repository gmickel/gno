/**
 * Intent-aware retrieval helpers.
 *
 * @module src/pipeline/intent
 */

import type { ChunkRow } from "../store/types";

const TOKEN_PATTERN = /[A-Za-z0-9][A-Za-z0-9.+#/_-]*/g;

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
]);

const MATCH_ANCHOR_BONUS = 0.2;

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeToken(token: string): string {
  return token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
}

/**
 * Extract meaningful steering terms from query/intent text.
 * Keeps short domain tokens like API/SQL/LLM while dropping common stop words.
 */
export function extractSteeringTerms(text: string): string[] {
  const matches = text.match(TOKEN_PATTERN) ?? [];
  const terms: string[] = [];

  for (const rawToken of matches) {
    const token = normalizeToken(rawToken);
    if (token.length < 2) {
      continue;
    }
    if (STOPWORDS.has(token)) {
      continue;
    }
    terms.push(token);
  }

  return dedupe(terms);
}

function scoreTextForTerms(text: string, terms: string[]): number {
  if (terms.length === 0 || text.length === 0) {
    return 0;
  }

  const haystack = text.toLowerCase();
  let score = 0;

  for (const term of terms) {
    if (haystack.includes(term)) {
      score += 1;
    }
  }

  return score;
}

export interface ChunkSelectionOptions {
  preferredSeq?: number | null;
  intentWeight: number;
}

/**
 * Choose the most query-relevant chunk in a document, with intent as a softer steer.
 */
export function selectBestChunkForSteering(
  chunks: ChunkRow[],
  query: string,
  intent: string | undefined,
  options: ChunkSelectionOptions
): ChunkRow | null {
  if (chunks.length === 0) {
    return null;
  }

  const queryTerms = extractSteeringTerms(query);
  const intentTerms = extractSteeringTerms(intent ?? "");
  const preferredSeq = options.preferredSeq ?? null;
  let bestChunk: ChunkRow | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const chunk of chunks) {
    const queryScore = scoreTextForTerms(chunk.text, queryTerms);
    const intentScore =
      scoreTextForTerms(chunk.text, intentTerms) * options.intentWeight;
    const preferredBonus =
      preferredSeq !== null && chunk.seq === preferredSeq
        ? MATCH_ANCHOR_BONUS
        : 0;
    const score = queryScore + intentScore + preferredBonus;

    if (score > bestScore) {
      bestScore = score;
      bestChunk = chunk;
      continue;
    }

    if (score === bestScore && bestChunk && chunk.seq < bestChunk.seq) {
      bestChunk = chunk;
    }
  }

  return bestChunk ?? chunks[0] ?? null;
}

/**
 * Build a rerank query that provides intent as context without becoming a search term.
 */
export function buildIntentAwareRerankQuery(
  query: string,
  intent?: string
): string {
  const trimmedIntent = intent?.trim();
  if (!trimmedIntent) {
    return query;
  }

  return `Intent: ${trimmedIntent}\nQuery: ${query}`;
}
