/**
 * CLI command: gno context check
 *
 * Validate context configuration.
 *
 * @module src/cli/commands/context/check
 */

import { getCollectionFromScope, loadConfig } from '../../../config';

/**
 * Exit codes
 */
const EXIT_SUCCESS = 0;

/**
 * Output format
 */
export type OutputFormat = 'terminal' | 'json' | 'md';

/**
 * Check result
 */
export type CheckResult = {
  valid: boolean;
  warnings: string[];
  errors: string[];
};

/**
 * Validate context configuration.
 *
 * Checks:
 * - Global scope exists
 * - Collection scopes reference existing collections
 * - Prefix scopes reference existing collections
 *
 * @param format - Output format (terminal, json, md)
 * @returns Exit code
 */
export async function contextCheck(
  format: OutputFormat = 'terminal'
): Promise<number> {
  // Load config
  const configResult = await loadConfig();
  if (!configResult.ok) {
    console.error(`Error: ${configResult.error.message}`);
    return 1;
  }

  const { contexts, collections } = configResult.value;

  const warnings: string[] = [];
  const errors: string[] = [];

  // Check global scope exists
  const hasGlobalScope = contexts.some((ctx) => ctx.scopeType === 'global');
  if (!hasGlobalScope) {
    warnings.push('No global scope (/) configured');
  }

  // Check collection and prefix scopes reference existing collections
  const collectionNames = new Set(collections.map((c) => c.name));

  for (const ctx of contexts) {
    const collectionName = getCollectionFromScope(ctx.scopeKey);
    if (collectionName && !collectionNames.has(collectionName)) {
      errors.push(
        `Scope "${ctx.scopeKey}" references non-existent collection: ${collectionName}`
      );
    }
  }

  const result: CheckResult = {
    valid: errors.length === 0,
    warnings,
    errors,
  };

  // Format and output
  formatOutput(format, result);
  return EXIT_SUCCESS;
}

/**
 * Format and output check results
 */
function formatOutput(format: OutputFormat, result: CheckResult): void {
  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (format === 'md') {
    formatMarkdown(result);
    return;
  }

  formatTerminal(result);
}

/**
 * Format check results as markdown
 */
function formatMarkdown(result: CheckResult): void {
  console.log('# Context Check\n');
  console.log(`**Valid:** ${result.valid}\n`);

  if (result.errors.length > 0) {
    console.log('## Errors\n');
    for (const error of result.errors) {
      console.log(`- ${error}`);
    }
    console.log('');
  }

  if (result.warnings.length > 0) {
    console.log('## Warnings\n');
    for (const warning of result.warnings) {
      console.log(`- ${warning}`);
    }
    console.log('');
  }

  if (result.valid && result.warnings.length === 0) {
    console.log('No issues found.');
  }
}

/**
 * Format check results for terminal
 */
function formatTerminal(result: CheckResult): void {
  if (result.valid) {
    console.log('✓ Context configuration is valid');
  } else {
    console.log('✗ Context configuration has errors');
  }

  if (result.errors.length > 0) {
    console.log('\nErrors:');
    for (const error of result.errors) {
      console.log(`  - ${error}`);
    }
  }

  if (result.warnings.length > 0) {
    console.log('\nWarnings:');
    for (const warning of result.warnings) {
      console.log(`  - ${warning}`);
    }
  }
}
