/**
 * gno collection add - Add a new collection
 */

import {
  type Collection,
  CollectionSchema,
  DEFAULT_EXCLUDES,
  DEFAULT_PATTERN,
  loadConfig,
  pathExists,
  saveConfig,
  toAbsolutePath,
} from '../../../config';
import { CliError } from '../../errors';

type AddOptions = {
  name?: string;
  pattern?: string;
  include?: string;
  exclude?: string;
  update?: string;
};

export async function collectionAdd(
  path: string,
  options: AddOptions
): Promise<void> {
  // Validate required name
  if (!options.name) {
    throw new CliError('VALIDATION', '--name is required');
  }

  const collectionName = options.name.toLowerCase();

  // Expand and validate path
  const absolutePath = toAbsolutePath(path);

  // Check if path exists
  const exists = await pathExists(absolutePath);
  if (!exists) {
    throw new CliError('VALIDATION', `Path does not exist: ${absolutePath}`);
  }

  // Load config
  const result = await loadConfig();
  if (!result.ok) {
    throw new CliError(
      'RUNTIME',
      `Failed to load config: ${result.error.message}`
    );
  }

  const config = result.value;

  // Check for duplicate name
  const existing = config.collections.find((c) => c.name === collectionName);
  if (existing) {
    throw new CliError(
      'VALIDATION',
      `Collection "${collectionName}" already exists`
    );
  }

  // Parse options
  const includeList = options.include
    ? options.include.split(',').map((ext) => ext.trim())
    : [];
  const excludeList = options.exclude
    ? options.exclude.split(',').map((p) => p.trim())
    : [...DEFAULT_EXCLUDES];

  // Build collection
  const collection: Collection = {
    name: collectionName,
    path: absolutePath,
    pattern: options.pattern ?? DEFAULT_PATTERN,
    include: includeList,
    exclude: excludeList,
    updateCmd: options.update,
  };

  // Validate collection
  const validation = CollectionSchema.safeParse(collection);
  if (!validation.success) {
    throw new CliError(
      'VALIDATION',
      `Invalid collection: ${validation.error.issues[0]?.message ?? 'unknown error'}`
    );
  }

  // Add to config
  config.collections.push(validation.data);

  // Save config
  const saveResult = await saveConfig(config);
  if (!saveResult.ok) {
    throw new CliError(
      'RUNTIME',
      `Failed to save config: ${saveResult.error.message}`
    );
  }

  process.stdout.write(`Collection "${collectionName}" added successfully\n`);
  process.stdout.write(`Path: ${absolutePath}\n`);
}
