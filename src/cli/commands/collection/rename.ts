/**
 * gno collection rename - Rename a collection
 */

import {
  CollectionSchema,
  getCollectionFromScope,
  loadConfig,
  saveConfig,
} from '../../../config';
import { CliError } from '../../errors';

export async function collectionRename(
  oldName: string,
  newName: string
): Promise<void> {
  const oldCollectionName = oldName.toLowerCase();
  const newCollectionName = newName.toLowerCase();

  // Load config
  const result = await loadConfig();
  if (!result.ok) {
    throw new CliError(
      'RUNTIME',
      `Failed to load config: ${result.error.message}`
    );
  }

  const config = result.value;

  // Find old collection
  const collection = config.collections.find(
    (c) => c.name === oldCollectionName
  );
  if (!collection) {
    throw new CliError(
      'VALIDATION',
      `Collection "${oldCollectionName}" not found`
    );
  }

  // Check if new name already exists
  const existingNew = config.collections.find(
    (c) => c.name === newCollectionName
  );
  if (existingNew) {
    throw new CliError(
      'VALIDATION',
      `Collection "${newCollectionName}" already exists`
    );
  }

  // Validate new name
  const testCollection = { ...collection, name: newCollectionName };
  const validation = CollectionSchema.safeParse(testCollection);
  if (!validation.success) {
    throw new CliError(
      'VALIDATION',
      `Invalid collection name: ${validation.error.issues[0]?.message ?? 'unknown error'}`
    );
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
    throw new CliError(
      'RUNTIME',
      `Failed to save config: ${saveResult.error.message}`
    );
  }

  process.stdout.write(
    `Collection "${oldCollectionName}" renamed to "${newCollectionName}"\n`
  );
}
