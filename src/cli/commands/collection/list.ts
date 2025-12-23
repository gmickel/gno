/**
 * gno collection list - List all collections
 */

import type { Collection } from '../../../config';
import { loadConfig } from '../../../config';

type ListOptions = {
  json?: boolean;
  md?: boolean;
};

function formatMarkdown(collections: Collection[]): void {
  console.log('# Collections\n');
  if (collections.length === 0) {
    console.log('No collections configured.\n');
    return;
  }

  for (const coll of collections) {
    console.log(`## ${coll.name}\n`);
    console.log(`- **Path:** ${coll.path}`);
    console.log(`- **Pattern:** ${coll.pattern}`);
    if (coll.include.length > 0) {
      console.log(`- **Include:** ${coll.include.join(', ')}`);
    }
    console.log(`- **Exclude:** ${coll.exclude.join(', ')}`);
    if (coll.updateCmd) {
      console.log(`- **Update Command:** \`${coll.updateCmd}\``);
    }
    console.log();
  }
}

function formatTerminal(collections: Collection[]): void {
  if (collections.length === 0) {
    console.log('No collections configured.');
    return;
  }

  console.log(`Collections (${collections.length}):\n`);
  for (const coll of collections) {
    console.log(`  ${coll.name}`);
    console.log(`    Path:    ${coll.path}`);
    console.log(`    Pattern: ${coll.pattern}`);
    if (coll.include.length > 0) {
      console.log(`    Include: ${coll.include.join(', ')}`);
    }
    if (coll.exclude.length > 0) {
      console.log(`    Exclude: ${coll.exclude.join(', ')}`);
    }
    if (coll.updateCmd) {
      console.log(`    Update:  ${coll.updateCmd}`);
    }
    console.log();
  }
}

export async function collectionList(options: ListOptions): Promise<void> {
  // Load config
  const result = await loadConfig();
  if (!result.ok) {
    console.error(`Error: Failed to load config: ${result.error.message}`);
    process.exit(2);
  }

  const config = result.value;

  // Format output
  if (options.json) {
    console.log(JSON.stringify(config.collections, null, 2));
  } else if (options.md) {
    formatMarkdown(config.collections);
  } else {
    formatTerminal(config.collections);
  }

  process.exit(0);
}
