/**
 * Install GNO agent skill to Claude Code or Codex.
 * Atomic install via temp directory + rename.
 *
 * @module src/cli/commands/skill/install
 */

import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError } from '../../errors.js';
import { getGlobals } from '../../program.js';
import {
  resolveSkillPaths,
  type SkillScope,
  type SkillTarget,
  validatePathForDeletion,
} from './paths.js';

// ─────────────────────────────────────────────────────────────────────────────
// Source Path Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get path to skill source files.
 * Works in both dev (src/) and after build (dist/).
 */
function getSkillSourceDir(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  // From src/cli/commands/skill/ -> assets/skill/
  // Or from dist/cli/commands/skill/ -> assets/skill/
  return join(__dirname, '../../../../assets/skill');
}

// ─────────────────────────────────────────────────────────────────────────────
// Install Command
// ─────────────────────────────────────────────────────────────────────────────

export interface InstallOptions {
  scope?: SkillScope;
  target?: SkillTarget | 'all';
  force?: boolean;
  /** Override for testing */
  cwd?: string;
  /** Override for testing */
  homeDir?: string;
  /** JSON output (defaults to globals.json) */
  json?: boolean;
  /** Non-interactive mode (defaults to globals.yes) */
  yes?: boolean;
  /** Quiet mode (defaults to globals.quiet) */
  quiet?: boolean;
}

interface InstallResult {
  target: SkillTarget;
  scope: SkillScope;
  path: string;
}

/**
 * Install skill to a single target.
 */
async function installToTarget(
  scope: SkillScope,
  target: SkillTarget,
  force: boolean,
  overrides?: { cwd?: string; homeDir?: string }
): Promise<InstallResult> {
  const sourceDir = getSkillSourceDir();
  const paths = resolveSkillPaths({ scope, target, ...overrides });

  // Check if already exists (directory or SKILL.md)
  const skillMdExists = await Bun.file(join(paths.gnoDir, 'SKILL.md')).exists();
  let dirExists = false;
  try {
    const dirStat = await stat(paths.gnoDir);
    dirExists = dirStat.isDirectory();
  } catch {
    // Directory doesn't exist
  }
  const destExists = skillMdExists || dirExists;

  if (destExists && !force) {
    throw new CliError(
      'VALIDATION',
      `Skill already installed at ${paths.gnoDir}. Use --force to overwrite.`
    );
  }

  // Read source files
  const sourceFiles = await readdir(sourceDir);
  if (sourceFiles.length === 0) {
    throw new CliError('RUNTIME', `No skill files found in ${sourceDir}`);
  }

  // Create temp directory with unique name to avoid collisions
  const randomSuffix = Math.random().toString(36).slice(2, 10);
  const tmpName = `.gno-skill.tmp.${Date.now()}-${process.pid}-${randomSuffix}`;
  const tmpDir = join(paths.skillsDir, tmpName);

  try {
    // Ensure skills directory exists
    await mkdir(paths.skillsDir, { recursive: true });

    // Create temp directory
    await mkdir(tmpDir, { recursive: true });

    // Copy all files to temp (binary-safe)
    for (const file of sourceFiles) {
      const content = await Bun.file(join(sourceDir, file)).arrayBuffer();
      await Bun.write(join(tmpDir, file), content);
    }

    // Remove existing if present (with safety check)
    if (destExists) {
      const validationError = validatePathForDeletion(paths.gnoDir, paths.base);
      if (validationError) {
        throw new CliError(
          'RUNTIME',
          `Safety check failed for ${paths.gnoDir}: ${validationError}`
        );
      }
      await rm(paths.gnoDir, { recursive: true, force: true });
    }

    // Atomic rename
    await rename(tmpDir, paths.gnoDir);

    return { target, scope, path: paths.gnoDir };
  } catch (err) {
    // Best-effort cleanup
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    if (err instanceof CliError) {
      throw err;
    }

    throw new CliError(
      'RUNTIME',
      `Failed to install skill: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Get globals with fallback for testing.
 */
function safeGetGlobals(): { json: boolean; yes: boolean; quiet: boolean } {
  try {
    return getGlobals();
  } catch {
    return { json: false, yes: false, quiet: false };
  }
}

/**
 * Install GNO skill.
 */
export async function installSkill(opts: InstallOptions = {}): Promise<void> {
  const scope = opts.scope ?? 'project';
  const target = opts.target ?? 'claude';
  const force = opts.force ?? false;
  const globals = safeGetGlobals();
  const json = opts.json ?? globals.json;
  const yes = opts.yes ?? globals.yes;
  const quiet = opts.quiet ?? globals.quiet;

  const targets: SkillTarget[] =
    target === 'all' ? ['claude', 'codex'] : [target];

  const results: InstallResult[] = [];

  for (const t of targets) {
    const result = await installToTarget(scope, t, force || yes, {
      cwd: opts.cwd,
      homeDir: opts.homeDir,
    });
    results.push(result);
  }

  // Output
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ installed: results }, null, 2)}\n`
    );
  } else if (!quiet) {
    for (const r of results) {
      process.stdout.write(`Installed GNO skill to ${r.path}\n`);
    }
    process.stdout.write('\nRestart your agent to load the skill.\n');
  }
}
