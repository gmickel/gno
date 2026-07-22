import type { DocumentRow } from "../store/types";

const RECEIPT_SCHEMA_VERSION = "1.0";
const INDEX_IMPLEMENTATION_ID = "documents_fts-bm25-v1";
const MAX_CONTENT_CHARS_PER_DOCUMENT = 32_768;
const MAX_CANDIDATES_PER_DOCUMENT = 32;
const MAX_TERM_CODEPOINTS = 64;
const CJK_PREFIX_CODEPOINTS = 4;
const TOKEN_PATTERN = /[\p{L}\p{N}_]+/gu;
const LETTER_PATTERN = /\p{L}/u;
const CJK_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

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
  "with",
  "der",
  "die",
  "das",
  "und",
  "ein",
  "eine",
  "le",
  "la",
  "les",
  "et",
  "un",
  "une",
  "il",
  "e",
  "per",
  "con",
]);

function sha256(value: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(value);
  return hasher.digest("hex");
}

function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function normalizeTerm(raw: string): string | null {
  const normalized = raw.normalize("NFKC").toLocaleLowerCase("und");
  const codepoints = Array.from(normalized);
  if (
    codepoints.length < 2 ||
    !LETTER_PATTERN.test(normalized) ||
    STOPWORDS.has(normalized)
  ) {
    return null;
  }
  if (codepoints.length <= MAX_TERM_CODEPOINTS) {
    return normalized;
  }
  if (CJK_PATTERN.test(normalized)) {
    return codepoints.slice(0, CJK_PREFIX_CODEPOINTS).join("");
  }
  return null;
}

/** Extract bounded Unicode FTS-compatible candidates in occurrence order. */
export function extractActivationProbeTerms(text: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  const input = text.slice(0, MAX_CONTENT_CHARS_PER_DOCUMENT);
  for (const match of input.matchAll(TOKEN_PATTERN)) {
    const term = normalizeTerm(match[0]);
    if (!term || seen.has(term)) {
      continue;
    }
    seen.add(term);
    terms.push(term);
    if (terms.length >= MAX_CANDIDATES_PER_DOCUMENT) {
      break;
    }
  }
  return terms;
}

export function fingerprintActivationIndex(input: {
  collection: string;
  indexName: string;
  schemaVersion: number;
  ftsTokenizer: string;
  documents: DocumentRow[];
}): string {
  const documents = input.documents
    .filter((document) => document.active)
    .map((document) => ({
      uri: document.uri,
      sourceHash: document.sourceHash,
      mirrorHash: document.mirrorHash,
    }))
    .sort((left, right) => compareText(left.uri, right.uri));
  return sha256(
    JSON.stringify({
      receiptSchemaVersion: RECEIPT_SCHEMA_VERSION,
      indexImplementation: INDEX_IMPLEMENTATION_ID,
      indexName: input.indexName,
      schemaVersion: input.schemaVersion,
      ftsTokenizer: input.ftsTokenizer,
      collection: input.collection,
      documents,
    })
  );
}
