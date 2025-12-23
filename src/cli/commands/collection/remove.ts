/**
 * gno collection remove - Remove a collection
 */

import {
  getCollectionFromScope,
  loadConfig,
  saveConfig,
} from '../../../config';

export async function collectionRemove(name: string): Promise<void> {
  const collectionName = name.toLowerCase();

  // Load config
  const result = await loadConfig();
  if (!result.ok) {
    console.error(`Error: Failed to load config: ${result.error.message}`);
    process.exit(2);
  }

  const config = result.value;

  // Find collection
  const collectionIndex = config.collections.findIndex(
    (c) => c.name === collectionName
  );
  if (collectionIndex === -1) {
    console.error(`Error: Collection "${collectionName}" not found`);
    process.exit(1);
  }

  // Check if any contexts reference this collection
  const referencingContexts = config.contexts.filter((ctx) => {
    const collFromScope = getCollectionFromScope(ctx.scopeKey);
    return collFromScope === collectionName;
  });

  if (referencingContexts.length > 0) {
    const scopes = referencingContexts.map((ctx) => ctx.scopeKey).join(', ');
    console.error(
      `Error: Collection "${collectionName}" is referenced by contexts: ${scopes}`
    );
    console.error('Remove the contexts first or rename the collection.');
    process.exit(1);
  }

  // Remove collection
  config.collections.splice(collectionIndex, 1);

  // Save config
  const saveResult = await saveConfig(config);
  if (!saveResult.ok) {
    console.error(`Error: Failed to save config: ${saveResult.error.message}`);
    process.exit(2);
  }

  console.log(`Collection "${collectionName}" removed successfully`);
  process.exit(0);
}
