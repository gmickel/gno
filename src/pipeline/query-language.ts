/**
 * Query language detection for prompt selection.
 *
 * IMPORTANT: This affects prompt selection and metadata ONLY.
 * It does NOT affect retrieval filtering - that's controlled by CLI --lang flag.
 */
import { franc } from 'franc';
import { iso6393 } from 'iso-639-3';

const MIN_RELIABLE_LENGTH = 15;

/** Supported languages for detection (ISO 639-3 codes) */
const SUPPORTED_LANGUAGES: readonly string[] = [
  'eng', // English
  'deu', // German
  'fra', // French
  'ita', // Italian
  'spa', // Spanish
  'por', // Portuguese
  'nld', // Dutch
  'cmn', // Mandarin Chinese
  'jpn', // Japanese
  'kor', // Korean
];

/** Build ISO 639-3 → BCP-47 (ISO 639-1) mapping at module init */
const ISO639_3_TO_BCP47: Record<string, string> = {};
for (const lang of iso6393) {
  if (lang.iso6391) {
    ISO639_3_TO_BCP47[lang.iso6393] = lang.iso6391;
  }
}

export interface LanguageDetection {
  /** BCP-47 code: 'en', 'de', 'fr', etc. 'und' if undetermined */
  bcp47: string;
  /** ISO 639-3 code: 'eng', 'deu', 'fra', etc. 'und' if undetermined */
  iso639_3: string;
  /** false if text too short or language undetermined */
  confident: boolean;
}

/**
 * Detect the language of query text for prompt selection.
 *
 * @param text - Query text to analyze
 * @returns Language detection result with BCP-47 code and confidence
 *
 * @example
 * detectQueryLanguage("wie konfiguriere ich kubernetes")
 * // { bcp47: 'de', iso639_3: 'deu', confident: true }
 *
 * detectQueryLanguage("hello")
 * // { bcp47: 'und', iso639_3: 'und', confident: false } // too short
 */
export function detectQueryLanguage(text: string): LanguageDetection {
  const trimmed = text.trim();

  if (trimmed.length < MIN_RELIABLE_LENGTH) {
    return { bcp47: 'und', iso639_3: 'und', confident: false };
  }

  const detected = franc(trimmed, {
    minLength: MIN_RELIABLE_LENGTH,
    only: [...SUPPORTED_LANGUAGES],
  });

  if (detected === 'und') {
    return { bcp47: 'und', iso639_3: 'und', confident: false };
  }

  const bcp47 = ISO639_3_TO_BCP47[detected];
  // Normalize both to 'und' if no BCP-47 mapping exists (contract consistency)
  if (!bcp47) {
    return { bcp47: 'und', iso639_3: 'und', confident: false };
  }
  return { bcp47, iso639_3: detected, confident: true };
}
