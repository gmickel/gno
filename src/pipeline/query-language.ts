/**
 * Query language detection for prompt selection.
 *
 * IMPORTANT: This affects prompt selection and metadata ONLY.
 * It does NOT affect retrieval filtering - that's controlled by CLI --lang flag.
 */
import { franc } from 'franc';

const MIN_RELIABLE_LENGTH = 15;

/**
 * Supported languages for detection.
 * Maps ISO 639-3 codes to BCP-47 (ISO 639-1) codes.
 *
 * Selection criteria:
 * - Major world languages by speaker count
 * - Significant tech/documentation communities
 * - Linguistically distinct (to minimize false positives)
 */
const LANG_MAP = {
  // Western European (Germanic)
  eng: 'en', // English
  deu: 'de', // German
  nld: 'nl', // Dutch

  // Western European (Romance)
  fra: 'fr', // French
  ita: 'it', // Italian
  spa: 'es', // Spanish
  por: 'pt', // Portuguese
  cat: 'ca', // Catalan
  ron: 'ro', // Romanian

  // Scandinavian
  swe: 'sv', // Swedish
  dan: 'da', // Danish
  nob: 'nb', // Norwegian Bokmål
  nno: 'nn', // Norwegian Nynorsk
  fin: 'fi', // Finnish

  // Eastern European
  pol: 'pl', // Polish
  ces: 'cs', // Czech
  slk: 'sk', // Slovak
  rus: 'ru', // Russian
  ukr: 'uk', // Ukrainian
  bul: 'bg', // Bulgarian
  hrv: 'hr', // Croatian
  ell: 'el', // Greek
  hun: 'hu', // Hungarian

  // Middle Eastern
  tur: 'tr', // Turkish
  ara: 'ar', // Arabic
  heb: 'he', // Hebrew
  fas: 'fa', // Persian/Farsi

  // South Asian
  hin: 'hi', // Hindi

  // Southeast Asian
  vie: 'vi', // Vietnamese
  tha: 'th', // Thai
  ind: 'id', // Indonesian

  // East Asian
  cmn: 'zh', // Mandarin Chinese
  jpn: 'ja', // Japanese
  kor: 'ko', // Korean
} as const;

/** ISO 639-3 codes for franc's only filter */
const SUPPORTED_LANGUAGES = Object.keys(LANG_MAP);

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
    only: SUPPORTED_LANGUAGES,
  });

  if (detected === 'und') {
    return { bcp47: 'und', iso639_3: 'und', confident: false };
  }

  const bcp47 = LANG_MAP[detected as keyof typeof LANG_MAP];
  if (!bcp47) {
    return { bcp47: 'und', iso639_3: 'und', confident: false };
  }
  return { bcp47, iso639_3: detected, confident: true };
}
