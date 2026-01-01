/**
 * Remove collection core logic.
 * Pure function that mutates config - caller handles I/O.
 *
 * @module src/collection/remove
 */

import { getCollectionFromScope } from '../config';
import type { Config } from '../config/types';
import type { CollectionResult, RemoveCollectionInput } from './types';

/**
 * Remove a collection from config.
 *
 * @param config - Current config (not mutated)
 * @param input - Collection name to remove
 * @returns New config with collection removed, or error
 */
export function removeCollection(
  config: Config,
  input: RemoveCollectionInput
): CollectionResult {
  const collectionName = input.name.toLowerCase();

  // Find collection
  const collection = config.collections.find((c) => c.name === collectionName);
  if (!collection) {
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: `Collection "${collectionName}" not found`,
    };
  }

  // Check if any contexts reference this collection
  const referencingContexts = (config.contexts ?? []).filter((ctx) => {
    const collFromScope = getCollectionFromScope(ctx.scopeKey);
    return collFromScope === collectionName;
  });

  if (referencingContexts.length > 0) {
    const scopes = referencingContexts.map((ctx) => ctx.scopeKey).join(', ');
    return {
      ok: false,
      code: 'HAS_REFERENCES',
      message: `Collection "${collectionName}" is referenced by contexts: ${scopes}. Remove the contexts first.`,
    };
  }

  // Create new config with collection removed (filter instead of splice)
  const newCollections = config.collections.filter(
    (c) => c.name !== collectionName
  );

  const newConfig: Config = {
    ...config,
    collections: newCollections,
  };

  return {
    ok: true,
    config: newConfig,
    collection,
  };
}
