/**
 * gno collection add - Add a new collection
 */

import { stat } from 'node:fs/promises';
import {
  type Collection,
  CollectionSchema,
  DEFAULT_EXCLUDES,
  DEFAULT_PATTERN,
  loadConfig,
  saveConfig,
  toAbsolutePath,
} from '../../../config';

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
    console.error('Error: --name is required');
    process.exit(1);
  }

  const collectionName = options.name.toLowerCase();

  // Expand and validate path
  const absolutePath = toAbsolutePath(path);

  // Check if path exists
  try {
    await stat(absolutePath);
  } catch {
    console.error(`Error: Path does not exist: ${absolutePath}`);
    process.exit(1);
  }

  // Load config
  const result = await loadConfig();
  if (!result.ok) {
    console.error(`Error: Failed to load config: ${result.error.message}`);
    process.exit(2);
  }

  const config = result.value;

  // Check for duplicate name
  const existing = config.collections.find((c) => c.name === collectionName);
  if (existing) {
    console.error(`Error: Collection "${collectionName}" already exists`);
    process.exit(1);
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
    console.error(
      `Error: Invalid collection: ${validation.error.issues[0]?.message ?? 'unknown error'}`
    );
    process.exit(1);
  }

  // Add to config
  config.collections.push(validation.data);

  // Save config
  const saveResult = await saveConfig(config);
  if (!saveResult.ok) {
    console.error(`Error: Failed to save config: ${saveResult.error.message}`);
    process.exit(2);
  }

  console.log(`Collection "${collectionName}" added successfully`);
  console.log(`Path: ${absolutePath}`);
  process.exit(0);
}
