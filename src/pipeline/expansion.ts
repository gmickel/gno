/**
 * Query expansion for hybrid search.
 * Uses GenerationPort to generate query variants.
 *
 * @module src/pipeline/expansion
 */

import { createHash } from 'node:crypto'; // No Bun alternative for hashing
import type { GenerationPort } from '../llm/types';
import type { StoreResult } from '../store/types';
import { ok } from '../store/types';
import type { ExpansionResult } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const EXPANSION_PROMPT_VERSION = 'v2';
const DEFAULT_TIMEOUT_MS = 5000;
// Non-greedy to avoid matching from first { to last } across multiple objects
const JSON_EXTRACT_PATTERN = /\{[\s\S]*?\}/;

// ─────────────────────────────────────────────────────────────────────────────
// Cache Key Generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate cache key for expansion results.
 * Key = SHA256(promptVersion || modelUri || query || lang)
 */
export function generateCacheKey(
  modelUri: string,
  query: string,
  lang: string
): string {
  const data = [EXPANSION_PROMPT_VERSION, modelUri, query, lang].join('\0');
  return createHash('sha256').update(data).digest('hex');
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
- Be concise - each variation 3-8 words
- HyDE should read like actual documentation, not a question

Respond with valid JSON only.`;

/**
 * Get prompt template for language.
 */
function getPromptTemplate(lang?: string): string {
  switch (lang?.toLowerCase()) {
    case 'en':
    case 'en-us':
    case 'en-gb':
      return EXPANSION_PROMPT_EN;
    case 'de':
    case 'de-de':
    case 'de-at':
    case 'de-ch':
      return EXPANSION_PROMPT_DE;
    default:
      return EXPANSION_PROMPT_MULTILINGUAL;
  }
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
      (q): q is string => typeof q === 'string' && q.length > 0
    );
    const vectorQueries = parsed.vectorQueries.filter(
      (q): q is string => typeof q === 'string' && q.length > 0
    );

    // Limit array sizes
    const result: ExpansionResult = {
      lexicalQueries: lexicalQueries.slice(0, 5),
      vectorQueries: vectorQueries.slice(0, 5),
    };

    // Optional fields
    if (typeof parsed.hyde === 'string' && parsed.hyde.length > 0) {
      result.hyde = parsed.hyde;
    }
    if (typeof parsed.notes === 'string') {
      result.notes = parsed.notes;
    }

    return result;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Expansion Function
// ─────────────────────────────────────────────────────────────────────────────

export interface ExpansionOptions {
  /** Language hint for prompt selection */
  lang?: string;
  /** Timeout in milliseconds */
  timeout?: number;
}

/**
 * Expand query using generation model.
 * Returns null on timeout or parse failure (graceful degradation).
 */
export async function expandQuery(
  genPort: GenerationPort,
  query: string,
  options: ExpansionOptions = {}
): Promise<StoreResult<ExpansionResult | null>> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;

  // Build prompt
  const template = getPromptTemplate(options.lang);
  const prompt = template.replace('{query}', query);

  // Run with timeout (clear timer to avoid resource leak)
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), timeout);
  });

  try {
    const result = await Promise.race([
      genPort.generate(prompt, {
        temperature: 0,
        seed: 42,
        maxTokens: 512,
      }),
      timeoutPromise,
    ]);

    // Clear timeout if generation completed first
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    // Timeout
    if (result === null) {
      return ok(null);
    }

    // Generation failed
    if (!result.ok) {
      return ok(null); // Graceful degradation
    }

    // Parse result
    const parsed = parseExpansionResult(result.value);
    return ok(parsed);
  } catch {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    return ok(null); // Graceful degradation
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cached Expansion
// ─────────────────────────────────────────────────────────────────────────────

export interface CachedExpansionDeps {
  genPort: GenerationPort;
  getCache: (key: string) => Promise<string | null>;
  setCache: (key: string, value: string) => Promise<void>;
}

/**
 * Expand query with caching.
 */
export async function expandQueryCached(
  deps: CachedExpansionDeps,
  query: string,
  options: ExpansionOptions = {}
): Promise<StoreResult<ExpansionResult | null>> {
  const lang = options.lang ?? 'auto';
  const cacheKey = generateCacheKey(deps.genPort.modelUri, query, lang);

  // Check cache
  const cached = await deps.getCache(cacheKey);
  if (cached) {
    const parsed = parseExpansionResult(cached);
    if (parsed) {
      return ok(parsed);
    }
  }

  // Generate
  const result = await expandQuery(deps.genPort, query, options);
  if (!result.ok) {
    return result;
  }

  // Cache result
  if (result.value) {
    await deps.setCache(cacheKey, JSON.stringify(result.value));
  }

  return result;
}
