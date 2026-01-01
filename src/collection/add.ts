/**
 * Add collection core logic.
 * Pure function that mutates config - caller handles I/O.
 *
 * @module src/collection/add
 */

import {
  type Collection,
  CollectionSchema,
  DEFAULT_EXCLUDES,
  DEFAULT_PATTERN,
  pathExists,
  toAbsolutePath,
} from '../config';
import type { Config } from '../config/types';
import type { AddCollectionInput, CollectionResult } from './types';

/**
 * Parse comma-separated string or array into deduplicated array.
 */
function parseList(input: string[] | string | undefined): string[] {
  if (!input) {
    return [];
  }
  if (Array.isArray(input)) {
    return [...new Set(input.map((s) => s.trim()).filter(Boolean))];
  }
  return [
    ...new Set(
      input
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    ),
  ];
}

/**
 * Add a collection to config.
 *
 * @param config - Current config (not mutated)
 * @param input - Collection input
 * @returns New config with collection added, or error
 */
export async function addCollection(
  config: Config,
  input: AddCollectionInput
): Promise<CollectionResult> {
  const collectionName = input.name.toLowerCase();

  // Expand and validate path
  const absolutePath = toAbsolutePath(input.path);

  // Check if path exists
  const exists = await pathExists(absolutePath);
  if (!exists) {
    return {
      ok: false,
      code: 'PATH_NOT_FOUND',
      message: `Path does not exist: ${absolutePath}`,
    };
  }

  // Check for duplicate name
  const existing = config.collections.find((c) => c.name === collectionName);
  if (existing) {
    return {
      ok: false,
      code: 'DUPLICATE',
      message: `Collection "${collectionName}" already exists`,
    };
  }

  // Parse include/exclude lists
  const includeList = parseList(input.include);
  const excludeList =
    parseList(input.exclude).length > 0
      ? parseList(input.exclude)
      : [...DEFAULT_EXCLUDES];

  // Build collection
  const collection: Collection = {
    name: collectionName,
    path: absolutePath,
    pattern: input.pattern ?? DEFAULT_PATTERN,
    include: includeList,
    exclude: excludeList,
    updateCmd: input.updateCmd,
  };

  // Validate collection
  const validation = CollectionSchema.safeParse(collection);
  if (!validation.success) {
    return {
      ok: false,
      code: 'VALIDATION',
      message: `Invalid collection: ${validation.error.issues[0]?.message ?? 'unknown error'}`,
    };
  }

  // Create new config with collection added
  const newConfig: Config = {
    ...config,
    collections: [...config.collections, validation.data],
  };

  return {
    ok: true,
    config: newConfig,
    collection: validation.data,
  };
}
