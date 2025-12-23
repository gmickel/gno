/**
 * CLI command: gno context rm
 *
 * Remove a context.
 *
 * @module src/cli/commands/context/rm
 */

import { loadConfig, saveConfig } from '../../../config';

/**
 * Exit codes
 */
const EXIT_SUCCESS = 0;
const EXIT_VALIDATION = 1;

/**
 * Remove a context by scope.
 *
 * @param scope - Scope key to remove
 * @returns Exit code
 */
export async function contextRm(scope: string): Promise<number> {
  // Load config
  const configResult = await loadConfig();
  if (!configResult.ok) {
    console.error(`Error: ${configResult.error.message}`);
    return EXIT_VALIDATION;
  }

  const config = configResult.value;

  // Find context
  const index = config.contexts.findIndex((ctx) => ctx.scopeKey === scope);
  if (index === -1) {
    console.error(`Error: Context for scope "${scope}" not found`);
    return EXIT_VALIDATION;
  }

  // Remove context
  config.contexts.splice(index, 1);

  // Save config
  const saveResult = await saveConfig(config);
  if (!saveResult.ok) {
    console.error(`Error: ${saveResult.error.message}`);
    return EXIT_VALIDATION;
  }

  console.log(`Removed context for scope: ${scope}`);
  return EXIT_SUCCESS;
}
