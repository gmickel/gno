import { createHash } from "node:crypto"; // No Bun alternative for hashing
import { statSync } from "node:fs"; // No Bun sync stat alternative for local model file mtime/size
import { fileURLToPath } from "node:url"; // No Bun alternative for file:// URL decoding

import type { InferenceOptions } from "../llm/types";
/**
 * Query expansion for hybrid search.
 * Uses GenerationPort to generate query variants.
 *
 * @module src/pipeline/expansion
 */
import type { GenerationPort } from "../llm/types";
import type { StoreResult } from "../store/types";
import type { ExpansionResult } from "./types";

import {
  assertInferenceActive,
  assertInferenceResult,
  inferenceOptions,
  withInferencePage,
} from "../llm/inference-scope";
import { ok } from "../store/types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const EXPANSION_PROMPT_VERSION = "v3";
// Non-greedy to avoid matching from first { to last } across multiple objects
const JSON_EXTRACT_PATTERN = /\{[\s\S]*?\}/;
const QUOTED_PHRASE_PATTERN = /"([^"]+)"/g;
const NEGATION_PATTERN = /-(?:"([^"]+)"|([^\s]+))/g;
const TOKEN_PATTERN = /[A-Za-z0-9][A-Za-z0-9.+#_-]*/g;
const MAX_VARIANTS = 5;
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

// ─────────────────────────────────────────────────────────────────────────────
// Cache Key Generation
// ─────────────────────────────────────────────────────────────────────────────

export interface ExpansionCacheKeyOptions {
  /** Effective context size used for expansion generation. */
  contextSize?: number;
  /** Optional explicit model fingerprint; falls back to local file mtime/size. */
  modelFingerprint?: string;
  /** Resolved local model file path (e.g. cached GGUF for `hf:` or `file:` URIs). */
  modelPath?: string;
}

function statFileFingerprint(filePath: string): string | null {
  try {
    const stat = statSync(filePath);
    return `file:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch {
    return null;
  }
}

function resolveModelIdentityFingerprint(
  modelUri: string,
  options?: ExpansionCacheKeyOptions
): string | null {
  if (options?.modelFingerprint) {
    return options.modelFingerprint;
  }
  if (options?.modelPath) {
    return statFileFingerprint(options.modelPath);
  }
  if (modelUri.startsWith("file:")) {
    try {
      const filePath = modelUri.startsWith("file://")
        ? fileURLToPath(modelUri)
        : modelUri.slice("file:".length);
      return statFileFingerprint(filePath);
    } catch {
      return null;
    }
  }
  if (modelUri.startsWith("http://") || modelUri.startsWith("https://")) {
    return `uri:${modelUri}`;
  }
  return null;
}

/**
 * Generate cache key for expansion results.
 * Key = SHA256(promptVersion || modelUri || modelFingerprint || contextSize || query || lang || intent)
 */
export function generateCacheKey(
  modelUri: string,
  query: string,
  lang: string,
  intent?: string,
  options?: ExpansionCacheKeyOptions
): string {
  const fingerprint = resolveModelIdentityFingerprint(modelUri, options) ?? "";
  const contextSize =
    options?.contextSize !== undefined ? String(options.contextSize) : "";
  const data = [
    EXPANSION_PROMPT_VERSION,
    modelUri,
    fingerprint,
    contextSize,
    query,
    lang,
    intent?.trim() ?? "",
  ].join("\0");
  return createHash("sha256").update(data).digest("hex");
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt Templates
// ─────────────────────────────────────────────────────────────────────────────

const EXPANSION_PROMPT_EN = `You expand search queries for a hybrid search system.

Query: "{query}"

Generate JSON with:
1. "lexicalQueries": 2-3 keyword variations using synonyms (for BM25)
2. "vectorQueries": 2-3 semantic rephrasings capturing intent (for embeddings)
3. "hyde": A 50-100 word passage that directly answers the query, as if excerpted from a relevant document

Rules:
- Keep proper nouns exactly as written
- Preserve quoted phrases and negated terms from the query in lexicalQueries
- Keep symbol-heavy technical entities exactly (for example: C++, C#, Node.js)
- Be concise - each variation 3-8 words
- HyDE should read like actual documentation, not a question

Respond with valid JSON only.`;

const EXPANSION_PROMPT_DE = `Du erweiterst Suchanfragen für ein hybrides Suchsystem.

Anfrage: "{query}"

Generiere JSON mit:
1. "lexicalQueries": 2-3 Keyword-Variationen mit Synonymen (für BM25)
2. "vectorQueries": 2-3 semantische Umformulierungen (für Embeddings)
3. "hyde": Ein 50-100 Wort Abschnitt, der die Anfrage direkt beantwortet, wie aus einem relevanten Dokument

Regeln:
- Eigennamen exakt beibehalten
- Zitierte Phrasen und negierte Begriffe in lexicalQueries beibehalten
- Technische Begriffe mit Symbolen exakt halten (z. B. C++, C#, Node.js)
- Kurz halten - jede Variation 3-8 Wörter
- HyDE soll wie echte Dokumentation klingen, nicht wie eine Frage

Antworte nur mit validem JSON.`;

const EXPANSION_PROMPT_MULTILINGUAL = `You expand search queries for a hybrid search system. Respond in the same language as the query.

Query: "{query}"

Generate JSON with:
1. "lexicalQueries": 2-3 keyword variations using synonyms (for BM25)
2. "vectorQueries": 2-3 semantic rephrasings capturing intent (for embeddings)
3. "hyde": A 50-100 word passage that directly answers the query, as if excerpted from a relevant document

Rules:
- Keep proper nouns exactly as written
- Preserve quoted phrases and negated terms from the query in lexicalQueries
- Keep symbol-heavy technical entities exactly (for example: C++, C#, Node.js)
- Be concise - each variation 3-8 words
- HyDE should read like actual documentation, not a question

Respond with valid JSON only.`;

/**
 * Get prompt template for language.
 */
function getPromptTemplate(lang?: string): string {
  switch (lang?.toLowerCase()) {
    case "en":
    case "en-us":
    case "en-gb":
      return EXPANSION_PROMPT_EN;
    case "de":
    case "de-de":
    case "de-at":
    case "de-ch":
      return EXPANSION_PROMPT_DE;
    default:
      return EXPANSION_PROMPT_MULTILINGUAL;
  }
}

function buildPrompt(query: string, template: string, intent?: string): string {
  const basePrompt = template.replace("{query}", query);
  const trimmedIntent = intent?.trim();
  if (!trimmedIntent) {
    return basePrompt;
  }

  return basePrompt
    .replace(
      `Query: "${query}"\n`,
      `Query: "${query}"\nQuery intent: "${trimmedIntent}"\n`
    )
    .replace(
      `Anfrage: "${query}"\n`,
      `Anfrage: "${query}"\nQuery intent: "${trimmedIntent}"\n`
    );
}

interface QuerySignals {
  quotedPhrases: string[];
  negations: string[];
  criticalEntities: string[];
  overlapTokens: Set<string>;
}

function normalizeToken(token: string): string {
  return token.toLowerCase().trim();
}

function extractOverlapTokens(text: string): Set<string> {
  const matches = text.match(TOKEN_PATTERN) ?? [];
  const tokens: string[] = [];
  for (const rawToken of matches) {
    const token = normalizeToken(rawToken);
    if (token.length < 2) {
      continue;
    }
    if (STOPWORDS.has(token)) {
      continue;
    }
    tokens.push(token);
  }
  return new Set(tokens);
}

function dedupeStrings(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
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
  return out;
}

function extractQuerySignals(query: string): QuerySignals {
  const quotedPhrases = dedupeStrings(
    [...query.matchAll(QUOTED_PHRASE_PATTERN)]
      .map((m) => m[1]?.trim() ?? "")
      .filter(Boolean)
  );

  const negations = dedupeStrings(
    [...query.matchAll(NEGATION_PATTERN)]
      .map((m) => {
        const phrase = m[1]?.trim();
        if (phrase) {
          return `-"${phrase}"`;
        }
        const token = m[2]?.trim();
        return token ? `-${token}` : "";
      })
      .filter(Boolean)
  );

  const criticalEntities = dedupeStrings(
    (query.match(TOKEN_PATTERN) ?? []).filter((token) => {
      // Preserve common entity signals: uppercase/mixed case, acronyms, symbol-heavy technical terms.
      return (
        /[A-Z]/.test(token) ||
        /[+#.]/.test(token) ||
        /[A-Za-z]\d|\d[A-Za-z]/.test(token)
      );
    })
  );

  return {
    quotedPhrases,
    negations,
    criticalEntities,
    overlapTokens: extractOverlapTokens(query),
  };
}

function hasCaseInsensitiveSubstring(text: string, part: string): boolean {
  return text.toLowerCase().includes(part.toLowerCase());
}

function hasSufficientOverlap(
  querySignals: QuerySignals,
  candidate: string
): boolean {
  if (!candidate.trim()) {
    return false;
  }

  for (const phrase of querySignals.quotedPhrases) {
    if (hasCaseInsensitiveSubstring(candidate, phrase)) {
      return true;
    }
  }
  for (const entity of querySignals.criticalEntities) {
    if (hasCaseInsensitiveSubstring(candidate, entity)) {
      return true;
    }
  }
  for (const negation of querySignals.negations) {
    if (hasCaseInsensitiveSubstring(candidate, negation)) {
      return true;
    }
  }

  const candidateTokens = extractOverlapTokens(candidate);
  for (const token of candidateTokens) {
    if (querySignals.overlapTokens.has(token)) {
      return true;
    }
  }

  return false;
}

function buildAnchorLexicalQuery(
  query: string,
  querySignals: QuerySignals
): string {
  const parts: string[] = [];

  for (const entity of querySignals.criticalEntities) {
    parts.push(entity);
  }
  for (const phrase of querySignals.quotedPhrases) {
    parts.push(`"${phrase}"`);
  }
  for (const negation of querySignals.negations) {
    parts.push(negation);
  }

  const anchored = dedupeStrings(parts).join(" ").trim();
  return anchored || query.trim();
}

function normalizeVariants(
  variants: string[],
  querySignals: QuerySignals
): string[] {
  const deduped = dedupeStrings(variants);
  return deduped.filter((variant) =>
    hasSufficientOverlap(querySignals, variant)
  );
}

/**
 * Apply deterministic expansion guardrails:
 * - preserve entities/phrases/negations in lexical variants
 * - filter drifted variants with no overlap
 * - provide fallbacks when filtering removes all variants
 */
export function applyExpansionGuardrails(
  query: string,
  expansion: ExpansionResult
): ExpansionResult {
  const querySignals = extractQuerySignals(query);
  const anchorLexical = buildAnchorLexicalQuery(query, querySignals);

  const lexicalCandidates = [anchorLexical, ...expansion.lexicalQueries];
  const guardedLexical = normalizeVariants(lexicalCandidates, querySignals);
  const guardedVector = normalizeVariants(
    expansion.vectorQueries,
    querySignals
  );

  const lexicalQueries = (
    guardedLexical.length > 0 ? guardedLexical : [query.trim()]
  ).slice(0, MAX_VARIANTS);
  const vectorQueries = (
    guardedVector.length > 0 ? guardedVector : [query.trim()]
  ).slice(0, MAX_VARIANTS);

  const hyde =
    typeof expansion.hyde === "string" &&
    hasSufficientOverlap(querySignals, expansion.hyde)
      ? expansion.hyde.trim()
      : undefined;

  return {
    lexicalQueries,
    vectorQueries,
    hyde,
    notes: expansion.notes,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate and parse expansion result from LLM output.
 */
function parseExpansionResult(output: string): ExpansionResult | null {
  try {
    // Try to extract JSON from output (model may include extra text)
    const jsonMatch = output.match(JSON_EXTRACT_PATTERN);
    if (!jsonMatch) {
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

    // Validate required fields
    if (!Array.isArray(parsed.lexicalQueries)) {
      return null;
    }
    if (!Array.isArray(parsed.vectorQueries)) {
      return null;
    }

    // Validate array contents are strings
    const lexicalQueries = parsed.lexicalQueries.filter(
      (q): q is string => typeof q === "string" && q.length > 0
    );
    const vectorQueries = parsed.vectorQueries.filter(
      (q): q is string => typeof q === "string" && q.length > 0
    );

    // Limit array sizes
    const result: ExpansionResult = {
      lexicalQueries: lexicalQueries.slice(0, MAX_VARIANTS),
      vectorQueries: vectorQueries.slice(0, MAX_VARIANTS),
    };

    // Optional fields
    if (typeof parsed.hyde === "string" && parsed.hyde.trim().length > 0) {
      result.hyde = parsed.hyde.trim();
    }
    if (typeof parsed.notes === "string") {
      result.notes = parsed.notes;
    }

    return result;
  } catch {
    return null;
  }
}

/**
 * Build the exact expansion prompt used by production query expansion.
 * Exported for benchmark/eval harnesses that need to inspect raw model output.
 */
export function buildExpansionPrompt(
  query: string,
  options: Pick<ExpansionOptions, "lang" | "intent"> = {}
): string {
  const template = getPromptTemplate(options.lang);
  return buildPrompt(query, template, options.intent);
}

/**
 * Parse raw expansion output using the same schema + guardrails as production.
 * Exported for benchmark/eval harnesses that need raw-model diagnostics.
 */
export function parseExpansionOutput(
  output: string,
  query: string
): ExpansionResult | null {
  const parsed = parseExpansionResult(output);
  return parsed ? applyExpansionGuardrails(query, parsed) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Expansion Function
// ─────────────────────────────────────────────────────────────────────────────

export interface ExpansionOptions extends InferenceOptions {
  /** Language hint for prompt selection */
  lang?: string;
  /** Optional context that steers expansion for ambiguous queries */
  intent?: string;
  /** Optional bounded context size override for expansion generation */
  contextSize?: number;
}

/**
 * Expand query using generation model.
 * Returns null when generation fails or times out, or its output does not
 * parse (graceful degradation).
 */
export async function expandQuery(
  genPort: GenerationPort,
  query: string,
  options: ExpansionOptions = {}
): Promise<StoreResult<ExpansionResult | null>> {
  // Build prompt
  const prompt = buildExpansionPrompt(query, options);

  assertInferenceActive(options);
  const operational = inferenceOptions(options);
  try {
    // Expansion is best effort but has no budget of its own: slow hardware
    // (CPU generation takes 15-20s) and a cold model load still expand. A
    // generation that hits models.inferenceTimeout fails only expansion.
    const result = await withInferencePage(() =>
      genPort.generate(
        prompt,
        {
          temperature: 0,
          seed: 42,
          maxTokens: 512,
          contextSize: options.contextSize,
        },
        operational
      )
    );
    // Caller cancellation/deadline always wins and cannot become a lexical success.
    assertInferenceActive(options);
    if (!result) return ok(null);
    assertInferenceResult(result);
    if (!result.ok) return ok(null);
    return ok(parseExpansionOutput(result.value, query));
  } catch (cause) {
    assertInferenceActive(options);
    if (
      cause instanceof Error &&
      ["AbortError", "TimeoutError"].includes(cause.name)
    )
      throw cause;
    return ok(null);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cached Expansion
// ─────────────────────────────────────────────────────────────────────────────

export interface CachedExpansionDeps {
  genPort: GenerationPort;
  getCache: (key: string) => Promise<string | null>;
  setCache: (key: string, value: string) => Promise<void>;
  modelFingerprint?: string;
  modelPath?: string;
  onCacheLookup?: () => void;
  onCacheHit?: () => void;
}

/**
 * Strictly validate persisted expansion cache JSON written by expandQueryCached.
 * Rejects structurally corrupt entries (e.g. non-string array items or missing fields)
 * so they degrade cleanly to a cache miss and live generation.
 */
function parseCachedExpansionResult(raw: string): ExpansionResult | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    if (
      !Array.isArray(obj.lexicalQueries) ||
      !Array.isArray(obj.vectorQueries)
    ) {
      return null;
    }
    const lexicalQueries: string[] = [];
    for (const item of obj.lexicalQueries) {
      if (typeof item !== "string" || item.trim().length === 0) return null;
      lexicalQueries.push(item.trim());
    }
    const vectorQueries: string[] = [];
    for (const item of obj.vectorQueries) {
      if (typeof item !== "string" || item.trim().length === 0) return null;
      vectorQueries.push(item.trim());
    }
    let hyde: string | undefined;
    if (obj.hyde !== undefined) {
      if (typeof obj.hyde !== "string" || obj.hyde.trim().length === 0) {
        return null;
      }
      hyde = obj.hyde.trim();
    }
    if (lexicalQueries.length === 0 && vectorQueries.length === 0 && !hyde) {
      return null;
    }
    return { lexicalQueries, vectorQueries, hyde };
  } catch {
    return null;
  }
}

/**
 * Expand query with caching.
 */
export async function expandQueryCached(
  deps: CachedExpansionDeps,
  query: string,
  options: ExpansionOptions = {}
): Promise<StoreResult<ExpansionResult | null>> {
  const keyOptions: ExpansionCacheKeyOptions = {
    contextSize: options.contextSize,
    modelFingerprint: deps.modelFingerprint ?? deps.genPort.modelFingerprint,
    modelPath: deps.modelPath ?? deps.genPort.modelPath,
  };
  const resolvedIdentity = resolveModelIdentityFingerprint(
    deps.genPort.modelUri,
    keyOptions
  );
  // Skip persistent cache when the effective model artifact cannot be identified
  // (e.g. an `hf:` URI with no resolved local file path or fingerprint).
  if (resolvedIdentity === null) {
    return expandQuery(deps.genPort, query, options);
  }

  const lang = options.lang ?? "auto";
  const cacheKey = generateCacheKey(
    deps.genPort.modelUri,
    query,
    lang,
    options.intent,
    {
      contextSize: keyOptions.contextSize,
      modelFingerprint: resolvedIdentity,
    }
  );

  // Check cache (corrupt entries or read errors degrade cleanly to live expansion)
  deps.onCacheLookup?.();
  let cached: string | null = null;
  try {
    cached = await deps.getCache(cacheKey);
  } catch {
    cached = null;
  }
  if (cached) {
    const parsed = parseCachedExpansionResult(cached);
    if (parsed) {
      deps.onCacheHit?.();
      return ok(applyExpansionGuardrails(query, parsed));
    }
  }

  // Generate
  const result = await expandQuery(deps.genPort, query, options);
  if (!result.ok) {
    return result;
  }

  // Cache result (write failures never fail retrieval)
  if (result.value) {
    try {
      await deps.setCache(cacheKey, JSON.stringify(result.value));
    } catch {
      // Ignore cache persistence errors (e.g. read-only store or busy lock)
    }
  }

  return result;
}
