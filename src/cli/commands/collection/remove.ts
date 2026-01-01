/**
 * gno collection remove - Remove a collection
 */

import { removeCollection } from '../../../collection';
import { loadConfig, saveConfig } from '../../../config';
import { CliError } from '../../errors';

export async function collectionRemove(name: string): Promise<void> {
  // Load config
  const configResult = await loadConfig();
  if (!configResult.ok) {
    throw new CliError(
      'RUNTIME',
      `Failed to load config: ${configResult.error.message}`
    );
  }

  // Remove collection using shared module
  const result = removeCollection(configResult.value, { name });

  if (!result.ok) {
    // Map collection error codes to CLI error codes
    const cliCode =
      result.code === 'VALIDATION' ||
      result.code === 'NOT_FOUND' ||
      result.code === 'HAS_REFERENCES'
        ? 'VALIDATION'
        : 'RUNTIME';
    throw new CliError(cliCode, result.message);
  }

  // Save config
  const saveResult = await saveConfig(result.config);
  if (!saveResult.ok) {
    throw new CliError(
      'RUNTIME',
      `Failed to save config: ${saveResult.error.message}`
    );
  }

  process.stdout.write(
    `Collection "${result.collection.name}" removed successfully\n`
  );
}
