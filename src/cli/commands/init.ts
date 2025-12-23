/**
 * gno init command implementation.
 * Initializes GNO config, directories, and optionally adds a collection.
 *
 * @module src/cli/commands/init
 */

import { basename } from 'node:path';
import { getIndexDbPath } from '../../app/constants';
import {
  type Collection,
  createDefaultConfig,
  DEFAULT_EXCLUDES,
  DEFAULT_PATTERN,
  ensureDirectories,
  FTS_TOKENIZERS,
  type FtsTokenizer,
  getConfigPaths,
  isInitialized,
  isValidLanguageHint,
  loadConfigOrNull,
  pathExists,
  saveConfig,
  toAbsolutePath,
} from '../../config';

/** Pattern to replace invalid chars in collection names with hyphens */
const INVALID_NAME_CHARS = /[^a-z0-9_-]/g;

/** Pattern to strip leading non-alphanumeric from collection names */
const LEADING_NON_ALPHANUMERIC = /^[^a-z0-9]+/;

/**
 * Options for init command.
 */
export type InitOptions = {
  /** Optional path to add as collection */
  path?: string;
  /** Collection name (defaults to directory basename if path given) */
  name?: string;
  /** Glob pattern for file matching */
  pattern?: string;
  /** Extension allowlist CSV (e.g., ".md,.pdf") */
  include?: string;
  /** Exclude patterns CSV */
  exclude?: string;
  /** Shell command to run before indexing */
  update?: string;
  /** Skip prompts, accept defaults */
  yes?: boolean;
  /** Override config path */
  configPath?: string;
  /** FTS tokenizer (unicode61, porter, trigram) */
  tokenizer?: FtsTokenizer;
  /** BCP-47 language hint for collection */
  language?: string;
};

/**
 * Result of init command.
 */
export type InitResult = {
  success: boolean;
  alreadyInitialized?: boolean;
  configPath: string;
  dataDir: string;
  dbPath: string;
  collectionAdded?: string;
  error?: string;
};

/**
 * Handle case when already initialized.
 */
async function handleAlreadyInitialized(
  options: InitOptions,
  paths: ReturnType<typeof getConfigPaths>
): Promise<InitResult> {
  const config = await loadConfigOrNull(options.configPath);
  const dbPath = getIndexDbPath();

  if (!options.path) {
    return {
      success: true,
      alreadyInitialized: true,
      configPath: paths.configFile,
      dataDir: paths.dataDir,
      dbPath,
    };
  }

  if (!config) {
    return {
      success: false,
      configPath: paths.configFile,
      dataDir: paths.dataDir,
      dbPath,
      error: 'Config exists but could not be loaded',
    };
  }

  const collectionResult = await addCollectionToConfig(config, options);
  if (!collectionResult.success) {
    return {
      success: false,
      configPath: paths.configFile,
      dataDir: paths.dataDir,
      dbPath,
      error: collectionResult.error,
    };
  }

  const saveResult = await saveConfig(config, options.configPath);
  if (!saveResult.ok) {
    return {
      success: false,
      configPath: paths.configFile,
      dataDir: paths.dataDir,
      dbPath,
      error: saveResult.error.message,
    };
  }

  return {
    success: true,
    alreadyInitialized: true,
    configPath: paths.configFile,
    dataDir: paths.dataDir,
    dbPath,
    collectionAdded: collectionResult.collectionName,
  };
}

/**
 * Execute gno init command.
 */
export async function init(options: InitOptions = {}): Promise<InitResult> {
  const paths = getConfigPaths();

  // Check if already initialized
  const initialized = await isInitialized(options.configPath);
  if (initialized) {
    return handleAlreadyInitialized(options, paths);
  }

  // Create directories
  const dirResult = await ensureDirectories();
  if (!dirResult.ok) {
    return {
      success: false,
      configPath: paths.configFile,
      dataDir: paths.dataDir,
      dbPath: getIndexDbPath(),
      error: dirResult.error.message,
    };
  }

  // Validate tokenizer option if provided
  if (options.tokenizer && !FTS_TOKENIZERS.includes(options.tokenizer)) {
    return {
      success: false,
      configPath: paths.configFile,
      dataDir: paths.dataDir,
      dbPath: getIndexDbPath(),
      error: `Invalid tokenizer: ${options.tokenizer}. Valid: ${FTS_TOKENIZERS.join(', ')}`,
    };
  }

  // Create default config
  const config = createDefaultConfig();

  // Set tokenizer if provided
  if (options.tokenizer) {
    config.ftsTokenizer = options.tokenizer;
  }

  // Add collection if path provided
  let collectionName: string | undefined;
  if (options.path) {
    const collectionResult = await addCollectionToConfig(config, options);
    if (!collectionResult.success) {
      return {
        success: false,
        configPath: paths.configFile,
        dataDir: paths.dataDir,
        dbPath: getIndexDbPath(),
        error: collectionResult.error,
      };
    }
    collectionName = collectionResult.collectionName;
  }

  // Save config
  const saveResult = await saveConfig(config, options.configPath);
  if (!saveResult.ok) {
    return {
      success: false,
      configPath: paths.configFile,
      dataDir: paths.dataDir,
      dbPath: getIndexDbPath(),
      error: saveResult.error.message,
    };
  }

  // Create DB placeholder file (actual schema created on first use)
  const dbPath = getIndexDbPath();
  try {
    await Bun.write(dbPath, '');
  } catch (error) {
    return {
      success: false,
      configPath: paths.configFile,
      dataDir: paths.dataDir,
      dbPath,
      error: `Failed to create database file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return {
    success: true,
    configPath: paths.configFile,
    dataDir: paths.dataDir,
    dbPath,
    collectionAdded: collectionName,
  };
}

/**
 * Helper to add collection to config.
 */
async function addCollectionToConfig(
  config: ReturnType<typeof createDefaultConfig>,
  options: InitOptions
): Promise<
  { success: true; collectionName: string } | { success: false; error: string }
> {
  if (!options.path) {
    return { success: false, error: 'Path is required' };
  }

  // Convert to absolute path
  const absolutePath = toAbsolutePath(options.path);

  // Check if path exists (as directory or file)
  const exists = await pathExists(absolutePath);
  if (!exists) {
    return {
      success: false,
      error: `Path does not exist: ${absolutePath}`,
    };
  }

  // Determine collection name
  let collectionName =
    options.name ??
    basename(absolutePath).toLowerCase().replace(INVALID_NAME_CHARS, '-');

  // Ensure name starts with alphanumeric (strip leading non-alphanumeric)
  collectionName = collectionName.replace(LEADING_NON_ALPHANUMERIC, '');

  // Validate derived name
  if (!collectionName || collectionName.length > 64) {
    return {
      success: false,
      error:
        'Cannot derive valid collection name from path. Please specify --name explicitly.',
    };
  }

  // Check for duplicate name
  if (config.collections.some((c) => c.name === collectionName)) {
    return {
      success: false,
      error: `Collection "${collectionName}" already exists`,
    };
  }

  // Parse include/exclude CSV if provided
  const include = options.include
    ? options.include.split(',').map((ext) => ext.trim())
    : [];

  const exclude = options.exclude
    ? options.exclude.split(',').map((pattern) => pattern.trim())
    : [...DEFAULT_EXCLUDES];

  // Create collection
  const collection: Collection = {
    name: collectionName,
    path: absolutePath,
    pattern: options.pattern ?? DEFAULT_PATTERN,
    include,
    exclude,
  };

  if (options.update) {
    collection.updateCmd = options.update;
  }

  // Validate and set language hint if provided
  if (options.language) {
    if (!isValidLanguageHint(options.language)) {
      return {
        success: false,
        error: `Invalid language hint: ${options.language}. Use BCP-47 format (e.g., en, de, zh-CN)`,
      };
    }
    collection.languageHint = options.language;
  }

  // Add to config
  config.collections.push(collection);

  return { success: true, collectionName };
}
