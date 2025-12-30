/**
 * Uninstall GNO agent skill from Claude Code or Codex.
 * Includes safety checks before deletion.
 *
 * @module src/cli/commands/skill/uninstall
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError } from '../../errors.js';
import { getGlobals } from '../../program.js';
import {
  resolveSkillPaths,
  type SkillScope,
  type SkillTarget,
  validatePathForDeletion,
} from './paths.js';

// ─────────────────────────────────────────────────────────────────────────────
// Uninstall Command
// ─────────────────────────────────────────────────────────────────────────────

export interface UninstallOptions {
  scope?: SkillScope;
  target?: SkillTarget | 'all';
  /** Override for testing */
  cwd?: string;
  /** Override for testing */
  homeDir?: string;
  /** JSON output (defaults to globals.json) */
  json?: boolean;
  /** Quiet mode (defaults to globals.quiet) */
  quiet?: boolean;
}

interface UninstallResult {
  target: SkillTarget;
  scope: SkillScope;
  path: string;
}

/**
 * Uninstall skill from a single target.
 */
async function uninstallFromTarget(
  scope: SkillScope,
  target: SkillTarget,
  overrides?: { cwd?: string; homeDir?: string }
): Promise<UninstallResult | null> {
  const paths = resolveSkillPaths({ scope, target, ...overrides });

  // Check if exists
  const exists = await Bun.file(join(paths.gnoDir, 'SKILL.md')).exists();
  if (!exists) {
    return null;
  }

  // Safety validation
  const validationError = validatePathForDeletion(paths.gnoDir, paths.base);
  if (validationError) {
    throw new CliError(
      'RUNTIME',
      `Safety check failed for ${paths.gnoDir}: ${validationError}`
    );
  }

  // Remove directory
  try {
    await rm(paths.gnoDir, { recursive: true, force: true });
    return { target, scope, path: paths.gnoDir };
  } catch (err) {
    throw new CliError(
      'RUNTIME',
      `Failed to remove skill: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Get globals with fallback for testing.
 */
function safeGetGlobals(): { json: boolean; quiet: boolean } {
  try {
    return getGlobals();
  } catch {
    return { json: false, quiet: false };
  }
}

/**
 * Uninstall GNO skill.
 */
export async function uninstallSkill(
  opts: UninstallOptions = {}
): Promise<void> {
  const scope = opts.scope ?? 'project';
  const target = opts.target ?? 'claude';
  const globals = safeGetGlobals();
  const json = opts.json ?? globals.json;
  const quiet = opts.quiet ?? globals.quiet;

  const targets: SkillTarget[] =
    target === 'all' ? ['claude', 'codex'] : [target];

  const results: UninstallResult[] = [];
  const notFound: string[] = [];

  for (const t of targets) {
    const result = await uninstallFromTarget(scope, t, {
      cwd: opts.cwd,
      homeDir: opts.homeDir,
    });
    if (result) {
      results.push(result);
    } else {
      notFound.push(t);
    }
  }

  // If nothing was uninstalled
  if (results.length === 0) {
    throw new CliError(
      'VALIDATION',
      `GNO skill not found for ${targets.join(', ')} (${scope} scope)`
    );
  }

  // Output
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ uninstalled: results }, null, 2)}\n`
    );
  } else if (!quiet) {
    for (const r of results) {
      process.stdout.write(`Uninstalled GNO skill from ${r.path}\n`);
    }
    if (notFound.length > 0) {
      process.stdout.write(`(Not found for: ${notFound.join(', ')})\n`);
    }
  }
}
