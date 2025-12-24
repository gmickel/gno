/**
 * Deterministic language detection for chunks.
 * Uses simple heuristics - no external dependencies.
 *
 * @module src/ingestion/language
 */

import type { LanguageDetectorPort } from './types';

/**
 * CJK Unicode ranges for language detection.
 * - CJK Unified Ideographs: U+4E00-U+9FFF
 * - CJK Unified Ideographs Extension A: U+3400-U+4DBF
 * - Hiragana: U+3040-U+309F
 * - Katakana: U+30A0-U+30FF
 * - Hangul Syllables: U+AC00-U+D7AF
 */
const CJK_REGEX =
  /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/;

/** Regex to split on whitespace and punctuation */
const WORD_SPLIT_REGEX = /[\s\p{P}]+/u;

/** Regex for whitespace */
const WHITESPACE_REGEX = /\s/;

/** Hiragana range */
const HIRAGANA_REGEX = /[\u3040-\u309f]/;

/** Katakana range */
const KATAKANA_REGEX = /[\u30a0-\u30ff]/;

/** Hangul range */
const HANGUL_REGEX = /[\uac00-\ud7af]/;

/**
 * Character frequency thresholds for CJK detection.
 */
const CJK_THRESHOLD = 0.1; // 10% CJK chars triggers detection

/**
 * Common words for European language detection.
 * These are stop words that appear frequently.
 */
const LANGUAGE_MARKERS: Record<string, string[]> = {
  en: [
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
  ],
  de: [
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
  ],
  fr: [
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
  ],
  it: [
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
  ],
};

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
 * Count CJK characters in text.
 */
function countCjkChars(text: string): number {
  let count = 0;
  for (const char of text) {
    if (CJK_REGEX.test(char)) {
      count += 1;
    }
  }
  return count;
}

/**
 * Detect if text is primarily CJK (Chinese, Japanese, Korean).
 */
function detectCjk(text: string): 'zh' | 'ja' | 'ko' | null {
  const totalChars = [...text].filter((c) => !WHITESPACE_REGEX.test(c)).length;
  if (totalChars === 0) {
    return null;
  }

  const cjkCount = countCjkChars(text);
  const cjkRatio = cjkCount / totalChars;

  if (cjkRatio < CJK_THRESHOLD) {
    return null;
  }

  // Distinguish between CJK languages by script-specific characters
  const hasHiragana = HIRAGANA_REGEX.test(text);
  const hasKatakana = KATAKANA_REGEX.test(text);
  const hasHangul = HANGUL_REGEX.test(text);

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
 */
function detectEuropean(words: string[]): string | null {
  if (words.length < 10) {
    return null;
  }

  const scores: Record<string, number> = {};

  for (const [lang, markers] of Object.entries(LANGUAGE_MARKERS)) {
    const markerSet = new Set(markers);
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
