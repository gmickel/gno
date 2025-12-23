/**
 * Default config factory for GNO.
 *
 * @module src/config/defaults
 */

import { CONFIG_VERSION, type Config, DEFAULT_FTS_TOKENIZER } from './types';

/**
 * Create a default config object.
 * Used when initializing a new GNO installation.
 */
export function createDefaultConfig(): Config {
  return {
    version: CONFIG_VERSION,
    ftsTokenizer: DEFAULT_FTS_TOKENIZER,
    collections: [],
    contexts: [],
  };
}
