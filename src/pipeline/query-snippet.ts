/**
 * BM25 result snippets built from stored chunks.
 *
 * FTS5 `snippet()` re-tokenizes the whole body of every matched document
 * before LIMIT, which made long questions take seconds. Snippets are built
 * for the returned rows only: pick the chunk that best covers the query terms
 * (terms weighted by rarity across the returned chunks, so a chunk with
 * "ladder" beats one with only "the" and "does"; lowest seq on ties), then
 * its best 32-token window, with matching tokens wrapped in `<mark>`/`</mark>`
 * and `...` where the window cuts the chunk, as `snippet()` did. Chunk choice
 * uses substring presence of lightly stemmed terms; highlighting uses word
 * prefixes. Both approximate the index tokenizer and affect display only,
 * never ranking.
 *
 * @module src/pipeline/query-snippet
 */

/** Tokens per snippet window (the old `snippet(..., 32)` budget). */
const WINDOW_TOKENS = 32;

/** Repeat hits only break ties between windows with equal term coverage. */
const HIT_TIEBREAK = 1e-6;

const TOKEN_REGEX = /[\p{L}\p{N}\p{M}]+/gu;

/** Quoted phrase (optionally negated) or a bare token, as the lexical grammar splits them. */
const QUERY_PART_REGEX = /(-?)"([^"]*)"|(\S+)/g;

const DIACRITIC_REGEX = /\p{M}/gu;

const NON_ASCII_REGEX = /[^\p{ASCII}]/u;

/** Final doubled consonant left by suffix removal (`embedd` -> `embed`). */
const DOUBLED_CONSONANT_REGEX = /([bdfgkmnprt])\1$/;

/** Suffixes removed from query terms, longest first. */
const STEM_SUFFIXES = [
  "ational",
  "ations",
  "ation",
  "ings",
  "ions",
  "ers",
  "ied",
  "ies",
  "ing",
  "ion",
  "al",
  "ed",
  "er",
  "ly",
  "e",
  "s",
  "y",
];

const MIN_STEM_LENGTH = 3;

export interface SnippetTerms {
  /** Lowercase term prefixes (stemmed query words and diacritic-free forms). */
  prefixes: string[];
  /** Query word id per prefix; variants of one word share an id. */
  ids: number[];
  /** Anchored prefix matcher for one lowercased token. */
  token: RegExp;
  idByPrefix: Map<string, number>;
}

/** Query word ids present in one chunk. */
export interface ChunkTermSet {
  seq: number;
  terms: Set<number>;
}

interface Token {
  start: number;
  end: number;
  term: number;
}

const stripDiacritics = (text: string): string =>
  NON_ASCII_REGEX.test(text)
    ? text.normalize("NFD").replace(DIACRITIC_REGEX, "")
    : text;

function stemPrefix(term: string): string {
  if (term.length <= MIN_STEM_LENGTH) return term;
  for (const suffix of STEM_SUFFIXES) {
    if (
      term.endsWith(suffix) &&
      term.length - suffix.length >= MIN_STEM_LENGTH
    ) {
      const stem = term.slice(0, -suffix.length);
      return DOUBLED_CONSONANT_REGEX.test(stem) ? stem.slice(0, -1) : stem;
    }
  }
  return term;
}

/** Positive terms of a lexical query; null when there are none. */
export function createSnippetTerms(query: string): SnippetTerms | null {
  const idByPrefix = new Map<string, number>();
  let nextId = 0;
  for (const part of query.matchAll(QUERY_PART_REGEX)) {
    const bare = part[3];
    if (part[1] === "-" || bare?.startsWith("-")) continue;
    for (const [word] of (part[2] ?? bare ?? "").matchAll(TOKEN_REGEX)) {
      const lower = word.toLowerCase();
      for (const form of new Set([lower, stripDiacritics(lower)])) {
        const prefix = stemPrefix(form);
        if (!idByPrefix.has(prefix)) idByPrefix.set(prefix, nextId);
      }
      nextId += 1;
    }
  }
  if (idByPrefix.size === 0) return null;
  const prefixes = [...idByPrefix.keys()].sort((a, b) => b.length - a.length);
  return {
    prefixes,
    ids: prefixes.map((prefix) => idByPrefix.get(prefix) ?? -1),
    token: new RegExp(`^(?:${prefixes.join("|")})`, "u"),
    idByPrefix,
  };
}

/** In-memory equivalent of the store's chunk term presence query. */
export function chunkTermPresence(
  text: string,
  terms: SnippetTerms
): boolean[] {
  const lower = text.toLowerCase();
  return terms.prefixes.map((prefix) => lower.includes(prefix));
}

export function presentTermIds(
  present: boolean[],
  terms: SnippetTerms
): Set<number> {
  const ids = new Set<number>();
  for (const [index, flag] of present.entries()) {
    const id = terms.ids[index];
    if (flag && id !== undefined) ids.add(id);
  }
  return ids;
}

/** Rarity weight per query word across all candidate chunks. */
export function snippetTermWeights(
  chunks: Iterable<ChunkTermSet>
): Map<number, number> {
  let total = 0;
  const frequency = new Map<number, number>();
  for (const { terms } of chunks) {
    total += 1;
    for (const term of terms)
      frequency.set(term, (frequency.get(term) ?? 0) + 1);
  }
  const weights = new Map<number, number>();
  for (const [term, count] of frequency)
    weights.set(term, Math.log(1 + total / count));
  return weights;
}

/** Seq of the chunk with the best weighted coverage (lowest seq on ties). */
export function pickSnippetSeq(
  chunks: ChunkTermSet[],
  weights: Map<number, number>
): number | undefined {
  let best: ChunkTermSet | undefined;
  let bestScore = -1;
  for (const chunk of chunks) {
    let score = 0;
    for (const term of chunk.terms) score += weights.get(term) ?? 0;
    if (
      score > bestScore ||
      (score === bestScore && best && chunk.seq < best.seq)
    ) {
      bestScore = score;
      best = chunk;
    }
  }
  return best?.seq;
}

function tokenize(text: string, terms: SnippetTerms): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(TOKEN_REGEX)) {
    const start = match.index;
    const word = match[0];
    const prefix = terms.token.exec(stripDiacritics(word.toLowerCase()));
    tokens.push({
      start,
      end: start + word.length,
      term: prefix ? (terms.idByPrefix.get(prefix[0]) ?? -1) : -1,
    });
  }
  return tokens;
}

/** Start index of the window with the best weighted term coverage. */
function bestWindowStart(
  tokens: Token[],
  weights: Map<number, number>
): number {
  if (tokens.length <= WINDOW_TOKENS) return 0;
  const counts = new Map<number, number>();
  let covered = 0;
  let hits = 0;
  const add = (term: number, delta: number) => {
    if (term < 0) return;
    const count = (counts.get(term) ?? 0) + delta;
    counts.set(term, count);
    hits += delta;
    const weight = weights.get(term) ?? 1;
    if (delta > 0 && count === 1) covered += weight;
    if (delta < 0 && count === 0) covered -= weight;
  };
  let bestStart = 0;
  let bestScore = -1;
  for (let index = 0; index < tokens.length; index += 1) {
    add(tokens[index]?.term ?? -1, 1);
    const start = index - WINDOW_TOKENS + 1;
    if (start > 0) add(tokens[start - 1]?.term ?? -1, -1);
    if (start < 0) continue;
    const score = covered + hits * HIT_TIEBREAK;
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }
  // Center the hits inside the chosen window.
  let first = -1;
  let last = -1;
  for (let index = bestStart; index < bestStart + WINDOW_TOKENS; index += 1) {
    if ((tokens[index]?.term ?? -1) < 0) continue;
    if (first < 0) first = index;
    last = index;
  }
  if (first < 0) return bestStart;
  const centered = first - Math.floor((WINDOW_TOKENS - (last - first + 1)) / 2);
  return Math.max(0, Math.min(centered, tokens.length - WINDOW_TOKENS));
}

/** The best 32-token window of one chunk, query terms in `<mark>` tags. */
export function renderChunkSnippet(
  text: string,
  terms: SnippetTerms,
  weights: Map<number, number>
): string {
  const tokens = tokenize(text, terms);
  if (tokens.length === 0) return text;
  const start = bestWindowStart(tokens, weights);
  const end = Math.min(tokens.length, start + WINDOW_TOKENS) - 1;
  const atStart = start === 0;
  const atEnd = end === tokens.length - 1;
  let cursor = atStart ? 0 : (tokens[start]?.start ?? 0);
  let out = atStart ? "" : "...";
  for (let index = start; index <= end; index += 1) {
    const token = tokens[index];
    if (!token || token.term < 0) continue;
    out += `${text.slice(cursor, token.start)}<mark>${text.slice(token.start, token.end)}</mark>`;
    cursor = token.end;
  }
  out += text.slice(cursor, atEnd ? text.length : (tokens[end]?.end ?? 0));
  return atEnd ? out : `${out}...`;
}
