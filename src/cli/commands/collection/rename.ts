/**
 * gno collection rename - Rename a collection
 */

import {
  CollectionSchema,
  getCollectionFromScope,
  loadConfig,
  saveConfig,
} from '../../../config';

export async function collectionRename(
  oldName: string,
  newName: string
): Promise<void> {
  const oldCollectionName = oldName.toLowerCase();
  const newCollectionName = newName.toLowerCase();

  // Load config
  const result = await loadConfig();
  if (!result.ok) {
    console.error(`Error: Failed to load config: ${result.error.message}`);
    process.exit(2);
  }

  const config = result.value;

  // Find old collection
  const collection = config.collections.find(
    (c) => c.name === oldCollectionName
  );
  if (!collection) {
    console.error(`Error: Collection "${oldCollectionName}" not found`);
    process.exit(1);
  }

  // Check if new name already exists
  const existingNew = config.collections.find(
    (c) => c.name === newCollectionName
  );
  if (existingNew) {
    console.error(`Error: Collection "${newCollectionName}" already exists`);
    process.exit(1);
  }

  // Validate new name
  const testCollection = { ...collection, name: newCollectionName };
  const validation = CollectionSchema.safeParse(testCollection);
  if (!validation.success) {
    console.error(
      `Error: Invalid collection name: ${validation.error.issues[0]?.message ?? 'unknown error'}`
    );
    process.exit(1);
  }

  // Rename collection
  collection.name = newCollectionName;

  // Update contexts that reference this collection
  for (const context of config.contexts) {
    const collFromScope = getCollectionFromScope(context.scopeKey);
    if (collFromScope === oldCollectionName) {
      // Update scope key
      if (context.scopeType === 'collection') {
        context.scopeKey = `${newCollectionName}:`;
      } else if (context.scopeType === 'prefix') {
        // Replace collection name in URI
        context.scopeKey = context.scopeKey.replace(
          `gno://${oldCollectionName}/`,
          `gno://${newCollectionName}/`
        );
      }
    }
  }

  // Save config
  const saveResult = await saveConfig(config);
  if (!saveResult.ok) {
    console.error(`Error: Failed to save config: ${saveResult.error.message}`);
    process.exit(2);
  }

  console.log(
    `Collection "${oldCollectionName}" renamed to "${newCollectionName}"`
  );
  process.exit(0);
}
