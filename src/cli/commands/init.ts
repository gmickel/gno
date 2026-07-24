/**
 * gno init command implementation.
 * Initializes GNO config, directories, and optionally adds a collection.
 *
 * @module src/cli/commands/init
 */

import { basename } from "node:path";

import { getIndexDbPath } from "../../app/constants";
import {
  type Collection,
  createDefaultConfig,
  DEFAULT_EXCLUDES,
  DEFAULT_PATTERN,
  ensureDirectories,
  FTS_TOKENIZERS,
  type FtsTokenizer,
  getConfigPaths,
  isValidLanguageHint,
  pathExists,
  toAbsolutePath,
} from "../../config";
import { applyConfigFileChange } from "../../core/config-mutation";
import { SqliteAdapter } from "../../store/sqlite/adapter";

/** Pattern to replace invalid chars in collection names with hyphens */
const INVALID_NAME_CHARS = /[^a-z0-9_-]/g;

/** Pattern to strip leading non-alphanumeric from collection names */
const LEADING_NON_ALPHANUMERIC = /^[^a-z0-9]+/;

/**
 * Options for init command.
 */
export interface InitOptions {
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
}

/**
 * Result of init command.
 */
export interface InitResult {
  success: boolean;
  alreadyInitialized?: boolean;
  configPath: string;
  dataDir: string;
  dbPath: string;
  collectionAdded?: string;
  error?: string;
}

/**
 * Execute gno init command.
 */
export async function init(options: InitOptions = {}): Promise<InitResult> {
  const paths = getConfigPaths();
  const configPath = toAbsolutePath(options.configPath ?? paths.configFile);
  const dbPath = getIndexDbPath();

  const dirResult = await ensureDirectories();
  if (!dirResult.ok) {
    return {
      success: false,
      configPath,
      dataDir: paths.dataDir,
      dbPath,
      error: dirResult.error.message,
    };
  }

  if (options.tokenizer && !FTS_TOKENIZERS.includes(options.tokenizer)) {
    return {
      success: false,
      configPath,
      dataDir: paths.dataDir,
      dbPath,
      error: `Invalid tokenizer: ${options.tokenizer}. Valid: ${FTS_TOKENIZERS.join(", ")}`,
    };
  }

  const mutation = await applyConfigFileChange(
    {
      configPath,
      createConfigIfMissing: createDefaultConfig,
    },
    async (config, state) => {
      if (state.created && options.tokenizer) {
        config.ftsTokenizer = options.tokenizer;
      }
      let collectionName: string | undefined;
      if (options.path) {
        const collectionResult = await addCollectionToConfig(config, options);
        if (!collectionResult.success) {
          return {
            ok: false as const,
            error: collectionResult.error,
            code: "VALIDATION",
          };
        }
        collectionName = collectionResult.collectionName;
      }
      return {
        ok: true as const,
        config,
        skipSave: !state.created && !options.path,
        value: {
          alreadyInitialized: !state.created,
          collectionName,
        },
      };
    }
  );
  if (!mutation.ok) {
    return {
      success: false,
      configPath,
      dataDir: paths.dataDir,
      dbPath,
      error: mutation.error,
    };
  }

  const store = new SqliteAdapter();
  const opened = await store.open(dbPath, mutation.config.ftsTokenizer);
  if (!opened.ok) {
    return {
      success: false,
      configPath,
      dataDir: paths.dataDir,
      dbPath,
      error: `Failed to initialize database: ${opened.error.message}`,
    };
  }
  await store.close();

  return {
    success: true,
    alreadyInitialized: mutation.value?.alreadyInitialized || undefined,
    configPath,
    dataDir: paths.dataDir,
    dbPath,
    collectionAdded: mutation.value?.collectionName,
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
    return { success: false, error: "Path is required" };
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
    basename(absolutePath).toLowerCase().replace(INVALID_NAME_CHARS, "-");

  // Ensure name starts with alphanumeric (strip leading non-alphanumeric)
  collectionName = collectionName.replace(LEADING_NON_ALPHANUMERIC, "");

  // Validate derived name
  if (!collectionName || collectionName.length > 64) {
    return {
      success: false,
      error:
        "Cannot derive valid collection name from path. Please specify --name explicitly.",
    };
  }

  // Check for duplicate name
  if (config.collections.some((c) => c.name === collectionName)) {
    return {
      success: false,
      error: `Collection "${collectionName}" already exists`,
    };
  }

  // Parse include/exclude CSV if provided (filter empty entries)
  const include = options.include
    ? options.include
        .split(",")
        .map((ext) => ext.trim())
        .filter(Boolean)
    : [];

  const exclude = options.exclude
    ? options.exclude
        .split(",")
        .map((pattern) => pattern.trim())
        .filter(Boolean)
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
