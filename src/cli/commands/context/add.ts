/**
 * CLI command: gno context add
 *
 * Add context metadata for a scope.
 *
 * @module src/cli/commands/context/add
 */

import { loadConfig, parseScope, saveConfig } from '../../../config';

/**
 * Exit codes
 */
const EXIT_SUCCESS = 0;
const EXIT_VALIDATION = 1;

/**
 * Add context metadata for a scope.
 *
 * @param scope - Scope string (/, collection:, or gno://collection/path)
 * @param text - Context description text
 * @returns Exit code
 */
export async function contextAdd(scope: string, text: string): Promise<number> {
  // Parse scope
  const parsed = parseScope(scope);
  if (!parsed) {
    console.error(`Error: Invalid scope format: ${scope}`);
    console.error(
      'Valid formats: "/" (global), "name:" (collection), or "gno://collection/path" (prefix)'
    );
    return EXIT_VALIDATION;
  }

  // Load config
  const configResult = await loadConfig();
  if (!configResult.ok) {
    console.error(`Error: ${configResult.error.message}`);
    return EXIT_VALIDATION;
  }

  const config = configResult.value;

  // Check for duplicate scope
  const existing = config.contexts.find((ctx) => ctx.scopeKey === parsed.key);
  if (existing) {
    console.error(`Error: Context for scope "${scope}" already exists`);
    return EXIT_VALIDATION;
  }

  // Add context
  config.contexts.push({
    scopeType: parsed.type,
    scopeKey: parsed.key,
    text,
  });

  // Save config
  const saveResult = await saveConfig(config);
  if (!saveResult.ok) {
    console.error(`Error: ${saveResult.error.message}`);
    return EXIT_VALIDATION;
  }

  console.log(`Added context for scope: ${scope}`);
  return EXIT_SUCCESS;
}
