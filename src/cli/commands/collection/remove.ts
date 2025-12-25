/**
 * gno collection remove - Remove a collection
 */

import {
  getCollectionFromScope,
  loadConfig,
  saveConfig,
} from '../../../config';
import { CliError } from '../../errors';

export async function collectionRemove(name: string): Promise<void> {
  const collectionName = name.toLowerCase();

  // Load config
  const result = await loadConfig();
  if (!result.ok) {
    throw new CliError(
      'RUNTIME',
      `Failed to load config: ${result.error.message}`
    );
  }

  const config = result.value;

  // Find collection
  const collectionIndex = config.collections.findIndex(
    (c) => c.name === collectionName
  );
  if (collectionIndex === -1) {
    throw new CliError(
      'VALIDATION',
      `Collection "${collectionName}" not found`
    );
  }

  // Check if any contexts reference this collection
  const referencingContexts = config.contexts.filter((ctx) => {
    const collFromScope = getCollectionFromScope(ctx.scopeKey);
    return collFromScope === collectionName;
  });

  if (referencingContexts.length > 0) {
    const scopes = referencingContexts.map((ctx) => ctx.scopeKey).join(', ');
    throw new CliError(
      'VALIDATION',
      `Collection "${collectionName}" is referenced by contexts: ${scopes}. Remove the contexts first or rename the collection.`
    );
  }

  // Remove collection
  config.collections.splice(collectionIndex, 1);

  // Save config
  const saveResult = await saveConfig(config);
  if (!saveResult.ok) {
    throw new CliError(
      'RUNTIME',
      `Failed to save config: ${saveResult.error.message}`
    );
  }

  process.stdout.write(`Collection "${collectionName}" removed successfully\n`);
}
