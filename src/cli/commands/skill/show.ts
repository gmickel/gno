/**
 * Show/preview GNO skill files without installing.
 *
 * @module src/cli/commands/skill/show
 */

import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError } from '../../errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// Source Path Resolution
// ─────────────────────────────────────────────────────────────────────────────

function getSkillSourceDir(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return join(__dirname, '../../../../assets/skill');
}

// ─────────────────────────────────────────────────────────────────────────────
// Show Command
// ─────────────────────────────────────────────────────────────────────────────

export interface ShowOptions {
  file?: string;
  all?: boolean;
}

const DEFAULT_FILE = 'SKILL.md';

/**
 * Show skill file content.
 */
export async function showSkill(opts: ShowOptions = {}): Promise<void> {
  const sourceDir = getSkillSourceDir();

  // Get available files
  let files: string[];
  try {
    files = await readdir(sourceDir);
  } catch {
    throw new CliError('RUNTIME', `Skill files not found at ${sourceDir}`);
  }

  const mdFiles = files.filter((f) => f.endsWith('.md')).sort();

  if (opts.all) {
    // Show all files with separators
    for (const file of mdFiles) {
      process.stdout.write(`--- ${file} ---\n`);
      const content = await Bun.file(join(sourceDir, file)).text();
      process.stdout.write(`${content}\n`);
      process.stdout.write('\n');
    }
  } else {
    // Show single file
    const fileName = opts.file ?? DEFAULT_FILE;

    if (!mdFiles.includes(fileName)) {
      throw new CliError(
        'VALIDATION',
        `Unknown file: ${fileName}. Available: ${mdFiles.join(', ')}`
      );
    }

    const content = await Bun.file(join(sourceDir, fileName)).text();
    process.stdout.write(`${content}\n`);
  }

  // Always list available files at end
  process.stdout.write(`\nFiles: ${mdFiles.join(', ')}\n`);
}
