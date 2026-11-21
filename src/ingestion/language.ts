/**
 * Deterministic language detection for chunks.
 * Uses simple heuristics - no external dependencies.
 *
 * @module src/ingestion/language
 */

import type { LanguageDetectorPort } from "./types";

/** Regex to split on whitespace and punctuation */
const WORD_SPLIT_REGEX = /[\s\p{P}]+/u;

/** Hiragana upper bound (lower bound is 0x3040 fast-skip threshold) */
const HIRAGANA_MAX = 0x30_9f;

/** Katakana upper bound */
const KATAKANA_MAX = 0x30_ff;

/** Hangul range */
const HANGUL_MIN = 0xac_00;
const HANGUL_MAX = 0xd7_af;

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
    "the",
    "and",
    "is",
    "are",
    "was",
    "were",
    "be",
    "have",
    "has",
    "this",
    "that",
    "with",
    "for",
    "not",
  ]),
  de: new Set([
    "der",
    "die",
    "das",
    "und",
    "ist",
    "sind",
    "ein",
    "eine",
    "für",
    "mit",
    "auf",
    "den",
    "dem",
    "nicht",
  ]),
  fr: new Set([
    "le",
    "la",
    "les",
    "et",
    "est",
    "sont",
    "un",
    "une",
    "pour",
    "avec",
    "sur",
    "des",
    "dans",
    "pas",
  ]),
  it: new Set([
    "il",
    "la",
    "le",
    "e",
    "è",
    "sono",
    "un",
    "una",
    "per",
    "con",
    "su",
    "dei",
    "nel",
    "non",
  ]),
};

/** Single-pass bitmask map for European language markers (preserves en, de, fr, it order). */
const EUROPEAN_LANGS = ["en", "de", "fr", "it"] as const;
const MARKER_BITMASK = new Map<string, number>();
for (let langIndex = 0; langIndex < EUROPEAN_LANGS.length; langIndex += 1) {
  const lang = EUROPEAN_LANGS[langIndex];
  const markerSet = lang ? LANGUAGE_MARKER_SETS[lang] : undefined;
  if (!markerSet) continue;
  const bit = 1 << langIndex;
  for (const word of markerSet) {
    MARKER_BITMASK.set(word, (MARKER_BITMASK.get(word) ?? 0) | bit);
  }
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
 * Single-pass counting using charCodeAt with fast ASCII/Latin skip.
 */
// oxlint-disable-next-line max-lines-per-function -- Unicode range detection with multiple heuristics
function detectCjk(text: string): "zh" | "ja" | "ko" | null {
  let totalChars = 0;
  let cjkCount = 0;
  let hasHiragana = false;
  let hasKatakana = false;
  let hasHangul = false;

  const len = text.length;
  for (let i = 0; i < len; i += 1) {
    const cp = text.charCodeAt(i);
    // Preserve codepoint counting for UTF-16 surrogate pairs
    if (cp >= 0xd8_00 && cp <= 0xdb_ff && i + 1 < len) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc_00 && low <= 0xdf_ff) {
        i += 1;
        totalChars += 1;
        continue;
      }
    }
    if (cp < 0x30_40) {
      if (!isWhitespace(cp)) {
        totalChars += 1;
      }
      continue;
    }

    totalChars += 1;
    if (cp <= HIRAGANA_MAX) {
      cjkCount += 1;
      hasHiragana = true;
    } else if (cp <= KATAKANA_MAX) {
      cjkCount += 1;
      hasKatakana = true;
    } else if (
      (cp >= 0x4e_00 && cp <= 0x9f_ff) ||
      (cp >= 0x34_00 && cp <= 0x4d_bf)
    ) {
      cjkCount += 1;
    } else if (cp >= HANGUL_MIN && cp <= HANGUL_MAX) {
      cjkCount += 1;
      hasHangul = true;
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
    return "ja";
  }
  if (hasHangul) {
    return "ko";
  }

  // Default to Chinese for pure Han characters
  return "zh";
}

/**
 * Detect European language by word frequency.
 * Single pass over words using a pre-built bitmask map.
 */
function detectEuropean(words: string[]): string | null {
  const count = words.length;
  if (count < 10) {
    return null;
  }

  let en = 0;
  let de = 0;
  let fr = 0;
  let it = 0;

  for (let i = 0; i < count; i += 1) {
    const word = words[i];
    if (word === undefined) continue;
    const mask = MARKER_BITMASK.get(word);
    if (mask === undefined) continue;
    if (mask & 1) en += 1;
    if (mask & 2) de += 1;
    if (mask & 4) fr += 1;
    if (mask & 8) it += 1;
  }

  // Find language with highest score (must exceed threshold; preserve en, de, fr, it tie order)
  const threshold = 0.02; // 2% of words must be markers
  let bestLang: string | null = null;
  let bestScore = threshold;
  const counts = [en, de, fr, it] as const;

  for (let i = 0; i < EUROPEAN_LANGS.length; i += 1) {
    const score = (counts[i] ?? 0) / count;
    if (score > bestScore) {
      bestScore = score;
      bestLang = EUROPEAN_LANGS[i] ?? null;
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
