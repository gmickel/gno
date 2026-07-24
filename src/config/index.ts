/**
 * Config module public API.
 *
 * @module src/config
 */

export { createDefaultConfig } from "./defaults";
export {
  type ContentTypeRuleResolution,
  type ContentTypeBoostStatus,
  type ConfigWarning,
  buildContentTypeBoostStatus,
  fingerprintContentTypeMetadataRules,
  fingerprintContentTypeRules,
  formatConfigWarning,
  formatConfigWarnings,
  normalizeConfigContentTypes,
  normalizeContentTypes,
  type NormalizedContentTypeRule,
  resolveContentTypeRule,
  writeConfigWarningsToStderr,
} from "./content-types";
// Loading
export {
  isInitialized,
  type LoadError,
  type LoadResult,
  loadConfig,
  loadConfigFromPath,
  loadConfigOrNull,
} from "./loader";

// Path utilities
export {
  configExists,
  expandPath,
  getConfigPath,
  getConfigPaths,
  pathExists,
  type ResolvedDirs,
  toAbsolutePath,
} from "./paths";
// Saving
export {
  ensureDirectories,
  type SaveError,
  type SaveResult,
  saveConfig,
  saveConfigToPath,
  saveTextToPath,
} from "./saver";
// Types and schemas
export {
  CONFIG_VERSION,
  CONTENT_TYPE_SEARCH_BOOST_MAX,
  CONTENT_TYPE_SEARCH_BOOST_MIN,
  CONTENT_TYPE_SEARCH_BOOST_NEUTRAL,
  type Collection,
  CollectionSchema,
  type Config,
  ConfigSchema,
  HttpGatewayConfigSchema,
  HttpGatewayLimitsSchema,
  CONTENT_TYPE_GRAPH_HINTS,
  type ContentTypeConfig,
  type ContentTypeGraphHint,
  ContentTypeSchema,
  type Context,
  ContextSchema,
  DEFAULT_EXCLUDES,
  DEFAULT_FTS_TOKENIZER,
  DEFAULT_PATTERN,
  FTS_TOKENIZERS,
  type FtsTokenizer,
  getCollectionFromScope,
  isValidLanguageHint,
  parseScope,
  type ProjectProfileBinding,
  ProjectProfileBindingSchema,
  type ScopeType,
  ScopeTypeSchema,
} from "./types";
export type { HttpGatewayConfig } from "./types";
export {
  RETRIEVAL_TRACE_DEFAULT_RETENTION,
  type RetrievalTraceConfig,
  RetrievalTraceConfigSchema,
  type RetrievalTraceRedactionMode,
  RetrievalTraceRedactionModeSchema,
  type RetrievalTraceRetention,
  RetrievalTraceRetentionSchema,
} from "./retrieval-traces";
