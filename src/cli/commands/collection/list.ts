/**
 * gno collection list - List all collections
 */

import type { Collection } from '../../../config';
import { loadConfig } from '../../../config';
import { bold, cyan, dim } from '../../colors';
import { CliError } from '../../errors';

/**
 * Strip ANSI escape sequences and control characters from string.
 * Prevents terminal injection from user-controlled config values.
 */
function sanitize(input: string): string {
  // Strip ANSI escape sequences
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional for sanitization
  return input.replace(/\x1b\[[0-9;]*m/g, '').replace(/[\x00-\x1f\x7f]/g, '');
}

type ListOptions = {
  json?: boolean;
  md?: boolean;
};

function formatMarkdown(collections: Collection[]): string {
  const lines: string[] = ['# Collections', ''];
  if (collections.length === 0) {
    lines.push('No collections configured.');
    return lines.join('\n');
  }

  for (const coll of collections) {
    lines.push(`## ${coll.name}`, '');
    lines.push(`- **Path:** ${coll.path}`);
    lines.push(`- **Pattern:** ${coll.pattern}`);
    if (coll.include.length > 0) {
      lines.push(`- **Include:** ${coll.include.join(', ')}`);
    }
    if (coll.exclude.length > 0) {
      lines.push(`- **Exclude:** ${coll.exclude.join(', ')}`);
    }
    if (coll.updateCmd) {
      lines.push(`- **Update Command:** \`${coll.updateCmd}\``);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function formatTerminal(collections: Collection[]): string {
  if (collections.length === 0) {
    return dim('No collections configured.');
  }

  const lines: string[] = [
    `${bold('Collections')} ${dim(`(${collections.length})`)}`,
    '',
  ];
  for (const coll of collections) {
    // Sanitize all user-controlled values to prevent terminal injection
    const name = sanitize(coll.name);
    const path = sanitize(coll.path);
    const pattern = sanitize(coll.pattern);
    const include = coll.include.map(sanitize);
    const exclude = coll.exclude.map(sanitize);
    const updateCmd = coll.updateCmd ? sanitize(coll.updateCmd) : undefined;

    lines.push(`  ${cyan(bold(name))}`);
    lines.push(`    ${dim('Path:')}    ${path}`);
    lines.push(`    ${dim('Pattern:')} ${pattern}`);
    if (include.length > 0) {
      lines.push(`    ${dim('Include:')} ${include.join(', ')}`);
    }
    if (exclude.length > 0) {
      lines.push(`    ${dim('Exclude:')} ${dim(exclude.join(', '))}`);
    }
    if (updateCmd) {
      lines.push(`    ${dim('Update:')}  ${updateCmd}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export async function collectionList(options: ListOptions): Promise<void> {
  // Load config
  const result = await loadConfig();
  if (!result.ok) {
    throw new CliError(
      'RUNTIME',
      `Failed to load config: ${result.error.message}`
    );
  }

  const config = result.value;

  // Format and output
  let output: string;
  if (options.json) {
    output = JSON.stringify(config.collections, null, 2);
  } else if (options.md) {
    output = formatMarkdown(config.collections);
  } else {
    output = formatTerminal(config.collections);
  }

  process.stdout.write(`${output}\n`);
}
