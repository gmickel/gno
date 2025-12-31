/**
 * Deterministic language detection for chunks.
 * Uses simple heuristics - no external dependencies.
 *
 * @module src/ingestion/language
 */

import type { LanguageDetectorPort } from './types';

/** Regex to split on whitespace and punctuation */
const WORD_SPLIT_REGEX = /[\s\p{P}]+/u;

/** Hiragana range */
const HIRAGANA_MIN = 0x30_40;
const HIRAGANA_MAX = 0x30_9f;

/** Katakana range */
const KATAKANA_MIN = 0x30_a0;
const KATAKANA_MAX = 0x30_ff;

/** Hangul range */
const HANGUL_MIN = 0xac_00;
const HANGUL_MAX = 0xd7_af;

/** CJK ranges for quick codepoint checking */
const CJK_RANGES = [
  [0x4e_00, 0x9f_ff], // CJK Unified Ideographs
  [0x34_00, 0x4d_bf], // CJK Unified Ideographs Extension A
  [0x30_40, 0x30_9f], // Hiragana
  [0x30_a0, 0x30_ff], // Katakana
  [0xac_00, 0xd7_af], // Hangul
] as const;

/**
 * Character frequency thresholds for CJK detection.
 */
const CJK_THRESHOLD = 0.1; // 10% CJK chars triggers detection

/**
 * Common words for European language detection.
 * These are stop words that appear frequently.
 * Pre-built as Sets for O(1) lookup.
 */
const LANGUAGE_MARKER_SETS: Record<string, Set<string>> = {
  en: new Set([
    'the',
    'and',
    'is',
    'are',
    'was',
    'were',
    'be',
    'have',
    'has',
    'this',
    'that',
    'with',
    'for',
    'not',
  ]),
  de: new Set([
    'der',
    'die',
    'das',
    'und',
    'ist',
    'sind',
    'ein',
    'eine',
    'für',
    'mit',
    'auf',
    'den',
    'dem',
    'nicht',
  ]),
  fr: new Set([
    'le',
    'la',
    'les',
    'et',
    'est',
    'sont',
    'un',
    'une',
    'pour',
    'avec',
    'sur',
    'des',
    'dans',
    'pas',
  ]),
  it: new Set([
    'il',
    'la',
    'le',
    'e',
    'è',
    'sono',
    'un',
    'una',
    'per',
    'con',
    'su',
    'dei',
    'nel',
    'non',
  ]),
};

/**
 * Check if a codepoint is CJK.
 */
function isCjkCodepoint(cp: number): boolean {
  for (const [min, max] of CJK_RANGES) {
    if (cp >= min && cp <= max) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a codepoint is whitespace.
 */
function isWhitespace(cp: number): boolean {
  // Common whitespace codepoints
  return (
    cp === 0x20 || // space
    cp === 0x09 || // tab
    cp === 0x0a || // newline
    cp === 0x0d || // carriage return
    cp === 0x0c || // form feed
    cp === 0xa0 || // non-breaking space
    (cp >= 0x20_00 && cp <= 0x20_0a) // various spaces
  );
}

/**
 * Extract words from text for language analysis.
 */
function extractWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(WORD_SPLIT_REGEX)
    .filter((w) => w.length >= 2 && w.length <= 15);
}

/**
 * Detect if text is primarily CJK (Chinese, Japanese, Korean).
 * Single-pass counting for efficiency.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Unicode range detection with multiple language heuristics
function detectCjk(text: string): 'zh' | 'ja' | 'ko' | null {
  let totalChars = 0;
  let cjkCount = 0;
  let hasHiragana = false;
  let hasKatakana = false;
  let hasHangul = false;

  // Single pass through the string
  for (const char of text) {
    const cp = char.codePointAt(0);
    if (cp === undefined) {
      continue;
    }

    // Skip whitespace for total count
    if (!isWhitespace(cp)) {
      totalChars += 1;

      // Check CJK ranges
      if (isCjkCodepoint(cp)) {
        cjkCount += 1;

        // Also check for script-specific markers
        if (cp >= HIRAGANA_MIN && cp <= HIRAGANA_MAX) {
          hasHiragana = true;
        } else if (cp >= KATAKANA_MIN && cp <= KATAKANA_MAX) {
          hasKatakana = true;
        } else if (cp >= HANGUL_MIN && cp <= HANGUL_MAX) {
          hasHangul = true;
        }
      }
    }
  }

  if (totalChars === 0) {
    return null;
  }

  const cjkRatio = cjkCount / totalChars;

  if (cjkRatio < CJK_THRESHOLD) {
    return null;
  }

  // Distinguish between CJK languages by script-specific characters
  if (hasHiragana || hasKatakana) {
    return 'ja';
  }
  if (hasHangul) {
    return 'ko';
  }

  // Default to Chinese for pure Han characters
  return 'zh';
}

/**
 * Detect European language by word frequency.
 * Uses pre-built Sets for O(1) marker lookup.
 */
function detectEuropean(words: string[]): string | null {
  if (words.length < 10) {
    return null;
  }

  const scores: Record<string, number> = {};

  for (const [lang, markerSet] of Object.entries(LANGUAGE_MARKER_SETS)) {
    let matches = 0;

    for (const word of words) {
      if (markerSet.has(word)) {
        matches += 1;
      }
    }

    scores[lang] = matches / words.length;
  }

  // Find language with highest score (must exceed threshold)
  const threshold = 0.02; // 2% of words must be markers
  let bestLang: string | null = null;
  let bestScore = threshold;

  for (const [lang, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestLang = lang;
    }
  }

  return bestLang;
}

/**
 * Simple deterministic language detector.
 * Priority:
 * 1. CJK detection (script-based)
 * 2. European language detection (word frequency)
 * 3. null (undetermined)
 */
export class SimpleLanguageDetector implements LanguageDetectorPort {
  detect(text: string): string | null {
    if (!text || text.length < 50) {
      return null;
    }

    // Try CJK first (script-based, more reliable)
    const cjk = detectCjk(text);
    if (cjk) {
      return cjk;
    }

    // Try European languages
    const words = extractWords(text);
    return detectEuropean(words);
  }
}

/**
 * Default language detector instance.
 */
export const defaultLanguageDetector = new SimpleLanguageDetector();
