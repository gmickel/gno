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

const EXPANSION_PROMPT_VERSION = 'v1';
const DEFAULT_TIMEOUT_MS = 5000;

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

const EXPANSION_PROMPT_EN = `You are a query expansion assistant. Given a search query, generate alternative phrasings to improve search results.

Input query: "{query}"

Generate a JSON object with:
- "lexicalQueries": array of 2-3 keyword-based variations (for BM25 search)
- "vectorQueries": array of 2-3 semantic rephrasing (for embedding search)
- "hyde": a short hypothetical document passage that would answer the query (optional)

Respond ONLY with valid JSON, no explanation.

Example:
{
  "lexicalQueries": ["deployment process", "how to deploy", "deploying application"],
  "vectorQueries": ["steps to release software to production", "guide for application deployment"],
  "hyde": "To deploy the application, first run the build command, then push to the staging environment..."
}`;

const EXPANSION_PROMPT_DE = `Du bist ein Query-Erweiterungs-Assistent. Generiere alternative Formulierungen für die Suchanfrage.

Suchanfrage: "{query}"

Generiere ein JSON-Objekt mit:
- "lexicalQueries": Array mit 2-3 Keyword-Variationen (für BM25-Suche)
- "vectorQueries": Array mit 2-3 semantischen Umformulierungen (für Vektor-Suche)
- "hyde": Ein kurzer hypothetischer Dokumentenausschnitt, der die Anfrage beantworten würde (optional)

Antworte NUR mit validem JSON, keine Erklärung.`;

const EXPANSION_PROMPT_MULTILINGUAL = `You are a query expansion assistant. Generate alternative phrasings for the search query in the same language as the query.

Input query: "{query}"

Generate a JSON object with:
- "lexicalQueries": array of 2-3 keyword-based variations
- "vectorQueries": array of 2-3 semantic rephrasing
- "hyde": a short hypothetical document passage (optional)

Respond ONLY with valid JSON.`;

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
    const jsonMatch = output.match(/\{[\s\S]*\}/);
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

export type ExpansionOptions = {
  /** Language hint for prompt selection */
  lang?: string;
  /** Timeout in milliseconds */
  timeout?: number;
};

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

  // Run with timeout
  const timeoutPromise = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), timeout);
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
    return ok(null); // Graceful degradation
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cached Expansion
// ─────────────────────────────────────────────────────────────────────────────

export type CachedExpansionDeps = {
  genPort: GenerationPort;
  getCache: (key: string) => Promise<string | null>;
  setCache: (key: string, value: string) => Promise<void>;
};

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
