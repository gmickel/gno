/**
 * gno collection list - List all collections
 */

import type { Collection } from '../../../config';
import { loadConfig } from '../../../config';
import { CliError } from '../../errors';

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
    return 'No collections configured.';
  }

  const lines: string[] = [`Collections (${collections.length}):`, ''];
  for (const coll of collections) {
    lines.push(`  ${coll.name}`);
    lines.push(`    Path:    ${coll.path}`);
    lines.push(`    Pattern: ${coll.pattern}`);
    if (coll.include.length > 0) {
      lines.push(`    Include: ${coll.include.join(', ')}`);
    }
    if (coll.exclude.length > 0) {
      lines.push(`    Exclude: ${coll.exclude.join(', ')}`);
    }
    if (coll.updateCmd) {
      lines.push(`    Update:  ${coll.updateCmd}`);
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
