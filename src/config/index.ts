/**
 * Config module public API.
 *
 * @module src/config
 */

// biome-ignore lint/performance/noBarrelFile: intentional public API
export { createDefaultConfig } from './defaults';
// Loading
export {
  isInitialized,
  type LoadError,
  type LoadResult,
  loadConfig,
  loadConfigFromPath,
  loadConfigOrNull,
} from './loader';

// Path utilities
export {
  configExists,
  expandPath,
  getConfigPath,
  getConfigPaths,
  type ResolvedDirs,
  toAbsolutePath,
} from './paths';
// Saving
export {
  ensureDirectories,
  type SaveError,
  type SaveResult,
  saveConfig,
  saveConfigToPath,
} from './saver';
// Types and schemas
export {
  CONFIG_VERSION,
  type Collection,
  CollectionSchema,
  type Config,
  ConfigSchema,
  type Context,
  ContextSchema,
  DEFAULT_EXCLUDES,
  DEFAULT_FTS_TOKENIZER,
  DEFAULT_PATTERN,
  FTS_TOKENIZERS,
  type FtsTokenizer,
  getCollectionFromScope,
  parseScope,
  type ScopeType,
  ScopeTypeSchema,
} from './types';
