/**
 * `recall()`: scoped hybrid retrieval, reciprocal-rank fusion, budgeting,
 * and the content-free receipt.
 *
 * @module src/core/memory-recall
 */

import type { SearchResult } from "../pipeline/types";
import type {
  MemoryServiceDeps,
  RecalledFact,
  RecallInput,
  RecallResult,
} from "./memory-types";

import { searchBm25 } from "../pipeline/search";
import { searchVectorWithEmbedding } from "../pipeline/vsearch";
import { selectContextEvidence } from "./context-budget";
import { mergeEgressLineages } from "./egress-provenance";
import {
  buildRecallReceipt,
  compareCodeUnits,
  estimateTokens,
  memoryNow,
  readFact,
  requireIdentity,
  requireManagedCollection,
  requireScopes,
  utf8Bytes,
} from "./memory-fence";
import {
  MEMORY_EMPTY_RECALL_HINT,
  MEMORY_NO_MATCH_RECALL_HINT,
  MEMORY_OVER_BUDGET_RECALL_HINT,
  MEMORY_RECALL_ANY_TERM_MIN_RELATIVE_SCORE,
  MEMORY_RECALL_MAX_FACTS,
  MEMORY_RECALL_MAX_TOKENS,
  MEMORY_RECALL_RETRIEVAL_LIMIT,
  MEMORY_RRF_K,
  MEMORY_TOKEN_BYTES_ESTIMATE,
  MemoryError,
} from "./memory-types";

type RetrievalLeg = { source: "bm25" | "vector"; results: SearchResult[] };

/**
 * Function words dropped from the lexical leg so a question-shaped turn
 * retrieves on its content terms. English plus the common German, French,
 * and Italian question and function words.
 */
const RECALL_STOPWORDS = new Set([
  // English
  "a",
  "about",
  "am",
  "an",
  "and",
  "any",
  "anything",
  "are",
  "as",
  "at",
  "be",
  "been",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "how's",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "it's",
  "its",
  "know",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "please",
  "should",
  "so",
  "tell",
  "that",
  "the",
  "their",
  "them",
  "there",
  "these",
  "they",
  "this",
  "those",
  "to",
  "us",
  "was",
  "we",
  "were",
  "what",
  "what's",
  "when",
  "where",
  "where's",
  "which",
  "who",
  "who's",
  "whom",
  "whose",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
  // German
  "das",
  "dem",
  "den",
  "der",
  "des",
  "ein",
  "eine",
  "ist",
  "mit",
  "oder",
  "sind",
  "und",
  "uns",
  "von",
  "wann",
  "warum",
  "welche",
  "welcher",
  "welches",
  "wer",
  "wie",
  "wir",
  "wo",
  "zu",
  // French
  "avec",
  "comment",
  "dans",
  "de",
  "du",
  "est",
  "et",
  "la",
  "le",
  "les",
  "nous",
  "ou",
  "où",
  "pour",
  "pourquoi",
  "quand",
  "que",
  "quel",
  "quelle",
  "qui",
  "quoi",
  "sont",
  "sur",
  "un",
  "une",
  "vous",
  // Italian
  "che",
  "chi",
  "come",
  "con",
  "cosa",
  "da",
  "del",
  "della",
  "di",
  "dove",
  "il",
  "per",
  "perché",
  "quale",
  "quali",
  "sono",
]);

/** Whitespace tokens, keeping a quoted phrase (optionally negated) whole. */
const QUERY_TOKEN_PATTERN = /-?"[^"]*"|\S+/g;
/** Same character class the FTS term sanitizer keeps. */
const NON_TERM_CHARS = /[^\p{L}\p{N}'_]/gu;

/**
 * Content terms of a recall query: bare stopword tokens are dropped; quoted
 * phrases, negations, and compounds pass through. A query with no positive
 * content term left is returned unchanged.
 */
function recallContentQuery(query: string): string {
  const tokens = query.match(QUERY_TOKEN_PATTERN) ?? [];
  const kept = tokens.filter((token) => {
    if (token.startsWith("-") || token.includes('"')) return true;
    return !RECALL_STOPWORDS.has(
      token.replace(NON_TERM_CHARS, "").toLowerCase()
    );
  });
  const hasPositiveTerm = kept.some(
    (token) =>
      !token.startsWith("-") && token.replace(NON_TERM_CHARS, "").length > 0
  );
  return hasPositiveTerm ? kept.join(" ") : query;
}

/**
 * Lexical leg: BM25 over the content terms, every term required first. When
 * no fact carries all of them (a question-shaped turn), fall back to
 * any-term matching so facts sharing a content term still rank, best BM25
 * first, above a relative score floor. `null` means the query has no
 * searchable terms.
 */
async function searchLexical(
  deps: MemoryServiceDeps,
  input: { query: string; collection: string; scopes: string[] }
): Promise<SearchResult[] | null> {
  const contentQuery = recallContentQuery(input.query);
  const run = async (anyTerm: boolean) => {
    const bm25 = await searchBm25(deps.store, contentQuery, {
      collection: input.collection,
      limit: MEMORY_RECALL_RETRIEVAL_LIMIT,
      memoryFilter: { scopes: input.scopes, excludeSuperseded: true },
      ...(anyTerm
        ? {
            anyTerm,
            minRelativeScore: MEMORY_RECALL_ANY_TERM_MIN_RELATIVE_SCORE,
          }
        : {}),
    });
    if (bm25.ok) return bm25.value.results;
    if (bm25.error.code !== "INVALID_INPUT") {
      throw new MemoryError("MEMORY_QUERY_FAILED", bm25.error.message);
    }
    return null;
  };
  const allTerms = await run(false);
  return allTerms?.length === 0 ? run(true) : allTerms;
}

/**
 * Retrieval legs: BM25 always; vectors when an embedding port and a searchable
 * vector index are present. The eligible set is one unbounded in-query
 * scope+supersession filter; the vector leg only ever ranks inside it.
 */
async function retrieveLegs(
  deps: MemoryServiceDeps,
  input: { query: string; collection: string; scopes: string[] }
): Promise<{ legs: RetrievalLeg[]; retrieval: RecallResult["retrieval"] }> {
  const { store, config } = deps;
  const { query, collection, scopes } = input;
  const legs: RetrievalLeg[] = [];
  const lexical = await searchLexical(deps, input);
  if (lexical) {
    legs.push({ source: "bm25", results: lexical });
  }

  const retrieval: RecallResult["retrieval"] = { mode: "lexical" };
  const embedPort = deps.embedPort ?? null;
  const vectorIndex = deps.vectorIndex ?? null;
  if (!embedPort || !vectorIndex?.searchAvailable) {
    retrieval.semanticUnavailable = embedPort
      ? "vector index unavailable"
      : "no embedding model available";
    return { legs, retrieval };
  }

  const eligible = await store.listMemoryEligibleDocuments({
    collection,
    scopes,
    excludeSuperseded: true,
  });
  if (!eligible.ok) {
    throw new MemoryError("MEMORY_QUERY_FAILED", eligible.error.message);
  }
  const allowedMirrorHashes = [
    ...new Set(eligible.value.map((row) => row.mirrorHash)),
  ];
  if (allowedMirrorHashes.length === 0) {
    retrieval.mode = "hybrid";
    return { legs, retrieval };
  }
  const embedded = await embedPort.embed(query);
  if (!embedded.ok) {
    retrieval.semanticUnavailable = embedded.error.message;
    return { legs, retrieval };
  }
  const vector = await searchVectorWithEmbedding(
    { store, vectorIndex, embedPort, config },
    query,
    new Float32Array(embedded.value),
    {
      collection,
      limit: MEMORY_RECALL_RETRIEVAL_LIMIT,
      retrievalScope: { allowedMirrorHashes },
    }
  );
  if (vector.ok) {
    legs.push({ source: "vector", results: vector.value.results });
    retrieval.mode = "hybrid";
  } else {
    retrieval.semanticUnavailable = vector.error.message;
  }
  return { legs, retrieval };
}

/** Reciprocal-rank fusion keyed by URI (fact identity), deterministic ties. */
function fuseLegs(legs: RetrievalLeg[]): SearchResult[] {
  const fused = new Map<string, { result: SearchResult; score: number }>();
  for (const leg of legs) {
    for (const [index, result] of leg.results.entries()) {
      const entry = fused.get(result.uri) ?? { result, score: 0 };
      entry.score += 1 / (MEMORY_RRF_K + index + 1);
      fused.set(result.uri, entry);
    }
  }
  return [...fused.values()]
    .sort(
      (left, right) =>
        right.score - left.score ||
        compareCodeUnits(left.result.uri, right.result.uri)
    )
    .map((entry) => ({ ...entry.result, score: entry.score }));
}

async function materializeFacts(
  deps: MemoryServiceDeps,
  ranked: SearchResult[]
): Promise<Array<{ fact: RecalledFact; rank: number }>> {
  const materialized: Array<{ fact: RecalledFact; rank: number }> = [];
  for (const [index, result] of ranked.entries()) {
    if (!result.conversion?.mirrorHash || !result.egressLineage) continue;
    const fact = await readFact(deps.store, {
      uri: result.uri,
      docid: result.docid,
      mirrorHash: result.conversion.mirrorHash,
    });
    if (!fact) continue;
    materialized.push({
      rank: index + 1,
      fact: {
        ...fact,
        score: result.score,
        spanHash: fact.contentHash,
        egressLineage: result.egressLineage,
      },
    });
  }
  return materialized;
}

/**
 * Token budget via the shared context-evidence selector, then the fact cap.
 * Facts carry no facets, so the selector fills the budget in retrieval-rank
 * order (per-fact facets would make it prefer the shortest facts).
 */
function selectWithinBudget(
  materialized: Array<{ fact: RecalledFact; rank: number }>,
  maxFacts: number,
  maxTokens: number
): RecalledFact[] {
  const selection = selectContextEvidence({
    candidates: materialized.map(({ fact, rank }) => ({
      candidateId: fact.uri,
      uri: fact.uri,
      docid: fact.docid,
      startLine: 1,
      endLine: 1,
      passageHash: fact.contentHash,
      sourceHash: fact.contentHash,
      mirrorHash: fact.contentHash,
      text: fact.text,
      facets: [],
      retrievalRank: rank,
      value: fact,
    })),
    requestedFacets: [],
    limits: {
      requestedBytes: maxTokens * MEMORY_TOKEN_BYTES_ESTIMATE,
      requestedTokens: maxTokens,
      safetyMarginBytes: 0,
      safetyMarginTokens: 0,
      documentShareNumerator: 1,
      documentShareDenominator: 1,
    },
    projectCanonical: (state) => {
      const texts = state.selected.map((item) => item.value.text);
      return {
        value: texts,
        usedBytes: texts.reduce((sum, item) => sum + utf8Bytes(item), 0),
        usedTokens: texts.reduce((sum, item) => sum + estimateTokens(item), 0),
      };
    },
  });
  return selection.selected.slice(0, maxFacts).map((item) => item.value);
}

/**
 * Why nothing came back: facts matched but none fit the budget, the scope
 * holds facts but none matched, or the scope holds no current fact at all.
 */
async function emptyRecallHint(
  deps: MemoryServiceDeps,
  input: { collection: string; scopes: string[]; matched: number }
): Promise<string> {
  if (input.matched > 0) return MEMORY_OVER_BUDGET_RECALL_HINT;
  const eligible = await deps.store.listMemoryEligibleDocuments({
    collection: input.collection,
    scopes: input.scopes,
    excludeSuperseded: true,
  });
  if (!eligible.ok) {
    throw new MemoryError("MEMORY_QUERY_FAILED", eligible.error.message);
  }
  return eligible.value.length > 0
    ? MEMORY_NO_MATCH_RECALL_HINT
    : MEMORY_EMPTY_RECALL_HINT;
}

export async function recallFacts(
  deps: MemoryServiceDeps,
  rawInput: RecallInput
): Promise<RecallResult> {
  const identity = requireIdentity(rawInput);
  const query = rawInput.query?.trim();
  if (!query) {
    throw new MemoryError("MEMORY_QUERY_REQUIRED", "A query is required.");
  }
  const collection = requireManagedCollection(
    deps.collections,
    rawInput.collection
  );
  const scopes = requireScopes(rawInput.scopes);
  const maxFacts = rawInput.maxFacts ?? MEMORY_RECALL_MAX_FACTS;
  const maxTokens = rawInput.maxTokens ?? MEMORY_RECALL_MAX_TOKENS;
  if (
    !Number.isSafeInteger(maxFacts) ||
    maxFacts < 1 ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens < 1
  ) {
    throw new MemoryError(
      "MEMORY_BUDGET_INVALID",
      "maxFacts and maxTokens must be positive integers."
    );
  }

  const { legs, retrieval } = await retrieveLegs(deps, {
    query,
    collection: collection.name,
    scopes,
  });
  const materialized = await materializeFacts(deps, fuseLegs(legs));
  const facts = selectWithinBudget(materialized, maxFacts, maxTokens);
  const usedTokens = facts.reduce(
    (sum, fact) => sum + estimateTokens(fact.text),
    0
  );

  const receipt = buildRecallReceipt({
    identity,
    issuedAt: memoryNow(deps).toISOString(),
    memoryIds: facts.map((fact) => fact.docid),
    spanHashes: [...new Set(facts.map((fact) => fact.spanHash))].sort(),
  });

  return {
    facts,
    receipt,
    budget: {
      maxFacts,
      maxTokens,
      usedTokens,
      omitted: materialized.length - facts.length,
    },
    retrieval,
    ...(facts.length > 0
      ? {
          egressLineage: mergeEgressLineages(
            facts.map((fact) => fact.egressLineage)
          ),
        }
      : {
          hint: await emptyRecallHint(deps, {
            collection: collection.name,
            scopes,
            matched: materialized.length,
          }),
        }),
  };
}
