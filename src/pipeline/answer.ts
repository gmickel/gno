/**
 * Grounded answer generation.
 * Shared between CLI ask command and web API.
 *
 * @module src/pipeline/answer
 */

import type { GenerationPort } from '../llm/types';
import type { Citation, SearchResult } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const ANSWER_PROMPT = `You are answering a question using ONLY the provided context blocks.

Rules you MUST follow:
1) Use ONLY facts stated in the context blocks. Do NOT use outside knowledge.
2) Every factual statement must include an inline citation like [1] or [2] referring to a context block.
3) If the context does not contain enough information to answer, reply EXACTLY:
   "I don't have enough information in the provided sources to answer this question."
4) Do not cite sources you did not use. Do not invent citation numbers.

Question: {query}

Context blocks:
{context}

Write a concise answer (1-3 paragraphs).`;

/** Abstention message when LLM cannot ground answer */
export const ABSTENTION_MESSAGE =
  "I don't have enough information in the provided sources to answer this question.";

/** Max characters per snippet to avoid blowing up prompt size */
const MAX_SNIPPET_CHARS = 1500;

/** Max number of sources to include in context */
const MAX_CONTEXT_SOURCES = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Citation Processing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract VALID citation numbers from answer text.
 * Only returns numbers in range [1, maxCitation].
 */
export function extractValidCitationNumbers(
  answer: string,
  maxCitation: number
): number[] {
  const nums = new Set<number>();
  const re = /\[(\d+)\]/g;
  const matches = answer.matchAll(re);
  for (const match of matches) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n >= 1 && n <= maxCitation) {
      nums.add(n);
    }
  }
  return [...nums].sort((a, b) => a - b);
}

/**
 * Filter citations to only those actually referenced in the answer.
 */
export function filterCitationsByUse(
  citations: Citation[],
  validUsedNumbers: number[]
): Citation[] {
  const usedSet = new Set(validUsedNumbers);
  return citations.filter((_, idx) => usedSet.has(idx + 1));
}

/**
 * Renumber citations in answer text to match filtered citations.
 * E.g., if answer uses [2] and [5], renumber to [1] and [2].
 * Invalid citations (not in validUsedNumbers) are removed.
 */
export function renumberAnswerCitations(
  answer: string,
  validUsedNumbers: number[]
): string {
  const mapping = new Map<number, number>();
  for (let i = 0; i < validUsedNumbers.length; i++) {
    const oldNum = validUsedNumbers[i];
    if (oldNum !== undefined) {
      mapping.set(oldNum, i + 1);
    }
  }

  const re = /\[(\d+)\]/g;
  const replaced = answer.replace(re, (_match, numStr: string) => {
    const oldNum = Number(numStr);
    const newNum = mapping.get(oldNum);
    return newNum !== undefined ? `[${newNum}]` : '';
  });

  return replaced.replace(/ {2,}/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Answer Generation
// ─────────────────────────────────────────────────────────────────────────────

export interface AnswerGenerationResult {
  answer: string;
  citations: Citation[];
}

/**
 * Generate a grounded answer from search results.
 * Returns null if no valid context or generation fails.
 */
export async function generateGroundedAnswer(
  genPort: GenerationPort,
  query: string,
  results: SearchResult[],
  maxTokens: number
): Promise<AnswerGenerationResult | null> {
  const contextParts: string[] = [];
  const citations: Citation[] = [];
  let citationIndex = 0;

  for (const r of results.slice(0, MAX_CONTEXT_SOURCES)) {
    if (!r.snippet || r.snippet.trim().length === 0) {
      continue;
    }

    const snippet =
      r.snippet.length > MAX_SNIPPET_CHARS
        ? `${r.snippet.slice(0, MAX_SNIPPET_CHARS)}...`
        : r.snippet;

    citationIndex += 1;
    contextParts.push(`[${citationIndex}] ${snippet}`);
    citations.push({
      docid: r.docid,
      uri: r.uri,
      startLine: r.snippetRange?.startLine,
      endLine: r.snippetRange?.endLine,
    });
  }

  if (contextParts.length === 0) {
    return null;
  }

  const prompt = ANSWER_PROMPT.replace('{query}', query).replace(
    '{context}',
    contextParts.join('\n\n')
  );

  const result = await genPort.generate(prompt, {
    temperature: 0,
    maxTokens,
  });

  if (!result.ok) {
    return null;
  }

  return { answer: result.value, citations };
}

/**
 * Process raw answer result into final answer with cleaned citations.
 * Extracts valid citations, filters unused ones, and renumbers.
 */
export function processAnswerResult(rawResult: AnswerGenerationResult): {
  answer: string;
  citations: Citation[];
} {
  const maxCitation = rawResult.citations.length;
  const validUsedNums = extractValidCitationNumbers(
    rawResult.answer,
    maxCitation
  );
  const filteredCitations = filterCitationsByUse(
    rawResult.citations,
    validUsedNums
  );

  if (validUsedNums.length === 0 || filteredCitations.length === 0) {
    return { answer: ABSTENTION_MESSAGE, citations: [] };
  }

  const answer = renumberAnswerCitations(rawResult.answer, validUsedNums);
  return { answer, citations: filteredCitations };
}
