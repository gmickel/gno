/**
 * CLI command: gno context list
 *
 * List all configured contexts.
 *
 * @module src/cli/commands/context/list
 */

import { loadConfig } from '../../../config';

/**
 * Exit codes
 */
const EXIT_SUCCESS = 0;

/**
 * Output format
 */
export type OutputFormat = 'terminal' | 'json' | 'md';

/**
 * List all configured contexts.
 *
 * @param format - Output format (terminal, json, md)
 * @returns Exit code
 */
export async function contextList(
  format: OutputFormat = 'terminal'
): Promise<number> {
  // Load config
  const configResult = await loadConfig();
  if (!configResult.ok) {
    console.error(`Error: ${configResult.error.message}`);
    return 1;
  }

  const { contexts } = configResult.value;

  // Format and output
  formatOutput(format, contexts);
  return EXIT_SUCCESS;
}

/**
 * Format and output context list
 */
function formatOutput(
  format: OutputFormat,
  contexts: Array<{ scopeKey: string; text: string }>
): void {
  if (format === 'json') {
    formatJson(contexts);
    return;
  }

  if (format === 'md') {
    formatMarkdown(contexts);
    return;
  }

  formatTerminal(contexts);
}

/**
 * Format contexts as JSON
 */
function formatJson(contexts: Array<{ scopeKey: string; text: string }>): void {
  const output = contexts.map((ctx) => ({
    scope: ctx.scopeKey,
    text: ctx.text,
  }));
  console.log(JSON.stringify(output, null, 2));
}

/**
 * Format contexts as markdown
 */
function formatMarkdown(
  contexts: Array<{ scopeKey: string; text: string }>
): void {
  console.log('# Contexts\n');
  if (contexts.length === 0) {
    console.log('No contexts configured.');
    return;
  }

  console.log('| Scope | Text |');
  console.log('|-------|------|');
  for (const ctx of contexts) {
    console.log(`| ${ctx.scopeKey} | ${ctx.text} |`);
  }
}

/**
 * Format contexts for terminal
 */
function formatTerminal(
  contexts: Array<{ scopeKey: string; text: string }>
): void {
  if (contexts.length === 0) {
    console.log('No contexts configured.');
    return;
  }

  console.log('Contexts:');
  for (const ctx of contexts) {
    console.log(`  ${ctx.scopeKey} - ${ctx.text}`);
  }
}
