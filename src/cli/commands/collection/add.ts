/**
 * gno collection add - Add a new collection
 */

import { addCollection } from '../../../collection';
import {
  loadConfig,
  pathExists,
  saveConfig,
  toAbsolutePath,
} from '../../../config';
import { CliError } from '../../errors';

interface AddOptions {
  name?: string;
  pattern?: string;
  include?: string;
  exclude?: string;
  update?: string;
}

export async function collectionAdd(
  path: string,
  options: AddOptions
): Promise<void> {
  // Validate required name
  if (!options.name) {
    throw new CliError('VALIDATION', '--name is required');
  }

  // Validate path exists BEFORE loading config (user-friendly error ordering)
  const absolutePath = toAbsolutePath(path);
  const exists = await pathExists(absolutePath);
  if (!exists) {
    throw new CliError('VALIDATION', `Path does not exist: ${absolutePath}`);
  }

  // Load config
  const configResult = await loadConfig();
  if (!configResult.ok) {
    throw new CliError(
      'RUNTIME',
      `Failed to load config: ${configResult.error.message}`
    );
  }

  // Add collection using shared module
  const result = await addCollection(configResult.value, {
    path,
    name: options.name,
    pattern: options.pattern,
    include: options.include,
    exclude: options.exclude,
    updateCmd: options.update,
  });

  if (!result.ok) {
    // Map collection error codes to CLI error codes
    const cliCode =
      result.code === 'VALIDATION' ||
      result.code === 'PATH_NOT_FOUND' ||
      result.code === 'DUPLICATE'
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
    `Collection "${result.collection.name}" added successfully\n`
  );
  process.stdout.write(`Path: ${result.collection.path}\n`);
}
