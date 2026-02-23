/**
 * Grounded answer generation.
 * Shared between CLI ask command and web API.
 *
 * @module src/pipeline/answer
 */

import type { GenerationPort } from "../llm/types";
import type { StorePort } from "../store/types";
import type {
  AnswerContextEntry,
  AnswerContextExplain,
  Citation,
  SearchResult,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const ANSWER_PROMPT = `Answer the question using ONLY the context blocks below. Cite sources with [1], [2], etc.

Example:
Q: What is the capital of France?
Context:
[1] France is a country in Western Europe. Paris is the capital and largest city.
[2] The Eiffel Tower, built in 1889, is located in Paris.

Answer: Paris is the capital of France [1]. It is home to the Eiffel Tower [2].

---

Q: {query}

Context:
{context}

Answer:`;

/** Abstention message when LLM cannot ground answer */
export const ABSTENTION_MESSAGE =
  "I don't have enough information in the provided sources to answer this question.";

/** Max characters per document (~8K tokens) */
const MAX_DOC_CHARS = 32_000;

/** Max number of sources selected for grounded answer context */
const MAX_CONTEXT_SOURCES = 5;
/** Default source target for non-comparative queries */
const BASE_CONTEXT_SOURCES = 3;
/** Candidate pool before adaptive selection */
const CONTEXT_CANDIDATE_POOL = 12;

/** Fallback snippet limit when full content unavailable */
const MAX_SNIPPET_CHARS = 1500;

const FACET_SPLIT_RE = /\b(?:and|or|vs|versus)\b|[,;]+/gi;
const COMPARISON_QUERY_RE =
  /\b(?:compare|comparison|difference|different|vs|versus|trade-?off|pros|cons|conflict|between)\b/i;
const TOKEN_SPLIT_RE = /[^\p{L}\p{N}]+/u;
const QUERY_STOPWORDS = new Set([
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
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "vs",
  "versus",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
]);

interface SourceCandidate {
  result: SearchResult;
  normalizedScore: number;
  matchedQueryTokens: Set<string>;
  matchedFacetIndexes: Set<number>;
}

interface SelectedSource {
  candidate: SourceCandidate;
  reason: string;
}

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
    return newNum !== undefined ? `[${newNum}]` : "";
  });

  return replaced.replace(/ {2,}/g, " ").trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Answer Generation
// ─────────────────────────────────────────────────────────────────────────────

export interface AnswerGenerationResult {
  answer: string;
  citations: Citation[];
  answerContext: AnswerContextExplain;
}

export interface AnswerGenerationDeps {
  genPort: GenerationPort;
  store: StorePort | null;
}

function normalizeScore(score: number): number {
  if (!Number.isFinite(score)) {
    return 0;
  }
  return Math.max(0, Math.min(1, score));
}

function tokenize(text: string): string[] {
  return text
    .trim()
    .toLowerCase()
    .split(TOKEN_SPLIT_RE)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !QUERY_STOPWORDS.has(token));
}

function uniqueFacetTexts(query: string): string[] {
  const segments = query
    .split(FACET_SPLIT_RE)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length <= 1) {
    return query.trim().length > 0 ? [query.trim()] : [];
  }

  return [...new Set(segments)];
}

function buildCandidates(
  queryTokenSet: Set<string>,
  facetTokenSets: Set<string>[],
  results: SearchResult[]
): SourceCandidate[] {
  return results.map((result) => {
    const signalText = `${result.title ?? ""}\n${result.snippet ?? ""}`;
    const signalTokenSet = new Set(tokenize(signalText));

    const matchedQueryTokens = new Set<string>();
    for (const token of queryTokenSet) {
      if (signalTokenSet.has(token)) {
        matchedQueryTokens.add(token);
      }
    }

    const matchedFacetIndexes = new Set<number>();
    for (const [index, facetTokenSet] of facetTokenSets.entries()) {
      for (const token of facetTokenSet) {
        if (signalTokenSet.has(token)) {
          matchedFacetIndexes.add(index);
          break;
        }
      }
    }

    return {
      result,
      normalizedScore: normalizeScore(result.score),
      matchedQueryTokens,
      matchedFacetIndexes,
    };
  });
}

function dedupeByDocidBestScore(results: SearchResult[]): SearchResult[] {
  const bestByDocid = new Map<string, SearchResult>();

  for (const result of results) {
    const existing = bestByDocid.get(result.docid);
    if (!existing || result.score > existing.score) {
      bestByDocid.set(result.docid, result);
    }
  }

  return [...bestByDocid.values()].sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (Math.abs(scoreDiff) > 1e-9) {
      return scoreDiff;
    }
    return a.docid.localeCompare(b.docid);
  });
}

function selectAdaptiveSources(
  query: string,
  results: SearchResult[]
): { selected: SearchResult[]; explain: AnswerContextExplain } {
  const dedupedResults = dedupeByDocidBestScore(results).slice(
    0,
    CONTEXT_CANDIDATE_POOL
  );
  const queryTokens = tokenize(query);
  const queryTokenSet = new Set(queryTokens);
  const facets = uniqueFacetTexts(query);
  const facetTokenSets = facets.map((facet) => new Set(tokenize(facet)));
  const candidates = buildCandidates(
    queryTokenSet,
    facetTokenSets,
    dedupedResults
  );

  const comparisonIntent = COMPARISON_QUERY_RE.test(query);
  let targetSources = BASE_CONTEXT_SOURCES;
  if (comparisonIntent || facets.length >= 3) {
    targetSources = 5;
  } else if (facets.length >= 2) {
    targetSources = 4;
  }
  targetSources = Math.min(
    targetSources,
    MAX_CONTEXT_SOURCES,
    candidates.length
  );

  const coveredTokens = new Set<string>();
  const coveredFacets = new Set<number>();
  const selected: SelectedSource[] = [];
  const selectedDocids = new Set<string>();

  while (selected.length < targetSources) {
    let bestCandidate: SourceCandidate | null = null;
    let bestGain = Number.NEGATIVE_INFINITY;
    let bestReason = "relevance";

    for (const candidate of candidates) {
      const docid = candidate.result.docid;
      if (selectedDocids.has(docid)) {
        continue;
      }

      const newTokenHits = [...candidate.matchedQueryTokens].filter(
        (token) => !coveredTokens.has(token)
      ).length;
      const newFacetHits = [...candidate.matchedFacetIndexes].filter(
        (index) => !coveredFacets.has(index)
      ).length;

      const tokenGain =
        queryTokenSet.size > 0 ? newTokenHits / queryTokenSet.size : 0;
      const facetGain =
        facetTokenSets.length > 0 ? newFacetHits / facetTokenSets.length : 0;

      let gain =
        candidate.normalizedScore * 0.6 + tokenGain * 0.25 + facetGain * 0.15;

      if (comparisonIntent && selected.length > 0 && newFacetHits === 0) {
        gain -= 0.2;
      }

      let reason = "relevance";
      if (newFacetHits > 0) {
        reason = "new_facet_coverage";
      } else if (newTokenHits > 0) {
        reason = "new_query_coverage";
      }

      if (
        !bestCandidate ||
        gain > bestGain ||
        (Math.abs(gain - bestGain) <= 1e-9 &&
          candidate.normalizedScore > bestCandidate.normalizedScore)
      ) {
        bestCandidate = candidate;
        bestGain = gain;
        bestReason = reason;
      }
    }

    if (!bestCandidate) {
      break;
    }

    // Keep selection compact when marginal gain is exhausted.
    if (
      bestGain <= 0 &&
      selected.length >= 1 &&
      !comparisonIntent &&
      selected.length >= BASE_CONTEXT_SOURCES
    ) {
      break;
    }

    selected.push({ candidate: bestCandidate, reason: bestReason });
    selectedDocids.add(bestCandidate.result.docid);
    for (const token of bestCandidate.matchedQueryTokens) {
      coveredTokens.add(token);
    }
    for (const index of bestCandidate.matchedFacetIndexes) {
      coveredFacets.add(index);
    }
  }

  if (comparisonIntent && selected.length < 2) {
    for (const candidate of candidates) {
      if (selectedDocids.has(candidate.result.docid)) {
        continue;
      }
      selected.push({ candidate, reason: "comparison_balance" });
      selectedDocids.add(candidate.result.docid);
      if (selected.length >= 2) {
        break;
      }
    }
  }

  if (selected.length === 0 && candidates.length > 0) {
    const first = candidates[0];
    if (first) {
      selected.push({ candidate: first, reason: "fallback_top_result" });
      selectedDocids.add(first.result.docid);
    }
  }

  const toEntry = (
    candidate: SourceCandidate,
    reason: string
  ): AnswerContextEntry => ({
    docid: candidate.result.docid,
    uri: candidate.result.uri,
    score: candidate.normalizedScore,
    queryTokenHits: candidate.matchedQueryTokens.size,
    facetHits: candidate.matchedFacetIndexes.size,
    reason,
  });

  const selectedEntries = selected.map(({ candidate, reason }) =>
    toEntry(candidate, reason)
  );
  const droppedEntries = candidates
    .filter((candidate) => !selectedDocids.has(candidate.result.docid))
    .map((candidate) => toEntry(candidate, "lower_marginal_gain"));

  return {
    selected: selected.map((entry) => entry.candidate.result),
    explain: {
      strategy: "adaptive_coverage_v1",
      targetSources,
      facets,
      selected: selectedEntries,
      dropped: droppedEntries,
    },
  };
}

/**
 * Generate a grounded answer from search results.
 * Returns null if no valid context or generation fails.
 *
 * When store is provided, fetches full document content for better context.
 * Falls back to snippets if store unavailable or content fetch fails.
 */
// oxlint-disable-next-line max-lines-per-function -- sequential content processing with fallbacks
export async function generateGroundedAnswer(
  deps: AnswerGenerationDeps,
  query: string,
  results: SearchResult[],
  maxTokens: number
): Promise<AnswerGenerationResult | null> {
  const { genPort, store } = deps;
  const sourceSelection = selectAdaptiveSources(query, results);
  const contextParts: string[] = [];
  const citations: Citation[] = [];
  let citationIndex = 0;

  for (const r of sourceSelection.selected) {
    let content: string | null = null;
    let usedFullContent = false;

    // Try to fetch full document content if store available
    if (store && r.conversion?.mirrorHash) {
      const contentResult = await store.getContent(r.conversion.mirrorHash);
      if (contentResult.ok && contentResult.value) {
        content = contentResult.value;
        usedFullContent = true;
        // Truncate to max doc chars
        if (content.length > MAX_DOC_CHARS) {
          content = `${content.slice(0, MAX_DOC_CHARS)}\n\n[... truncated ...]`;
        }
      }
    }

    // Fallback to snippet if full content unavailable
    if (!content) {
      if (!r.snippet || r.snippet.trim().length === 0) {
        continue;
      }
      content =
        r.snippet.length > MAX_SNIPPET_CHARS
          ? `${r.snippet.slice(0, MAX_SNIPPET_CHARS)}...`
          : r.snippet;
    }

    citationIndex += 1;
    contextParts.push(`[${citationIndex}] ${content}`);
    // Clear line range when citing full content (not a specific snippet)
    citations.push({
      docid: r.docid,
      uri: r.uri,
      startLine: usedFullContent ? undefined : r.snippetRange?.startLine,
      endLine: usedFullContent ? undefined : r.snippetRange?.endLine,
    });
  }

  if (contextParts.length === 0) {
    return null;
  }

  const prompt = ANSWER_PROMPT.replace("{query}", query).replace(
    "{context}",
    contextParts.join("\n\n")
  );

  const result = await genPort.generate(prompt, {
    temperature: 0,
    maxTokens,
  });

  if (!result.ok) {
    return null;
  }

  return {
    answer: result.value,
    citations,
    answerContext: sourceSelection.explain,
  };
}

/**
 * Process raw answer result into final answer with cleaned citations.
 * Extracts valid citations, filters unused ones, and renumbers.
 */
export function processAnswerResult(rawResult: AnswerGenerationResult): {
  answer: string;
  citations: Citation[];
  answerContext: AnswerContextExplain;
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
    return {
      answer: ABSTENTION_MESSAGE,
      citations: [],
      answerContext: rawResult.answerContext,
    };
  }

  const answer = renumberAnswerCitations(rawResult.answer, validUsedNums);
  return {
    answer,
    citations: filteredCitations,
    answerContext: rawResult.answerContext,
  };
}
