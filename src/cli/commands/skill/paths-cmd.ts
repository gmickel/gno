/**
 * Show resolved skill installation paths.
 * Debugging helper for skill install/uninstall.
 *
 * @module src/cli/commands/skill/paths-cmd
 */

import { join } from 'node:path';
import { getGlobals } from '../../program.js';
import { resolveAllPaths, type SkillScope, type SkillTarget } from './paths.js';

// ─────────────────────────────────────────────────────────────────────────────
// Paths Command
// ─────────────────────────────────────────────────────────────────────────────

export interface PathsOptions {
  scope?: SkillScope | 'all';
  target?: SkillTarget | 'all';
  /** Override for testing */
  cwd?: string;
  /** Override for testing */
  homeDir?: string;
  /** JSON output (defaults to globals.json) */
  json?: boolean;
}

interface PathInfo {
  target: SkillTarget;
  scope: SkillScope;
  path: string;
  exists: boolean;
}

/**
 * Get globals with fallback for testing.
 */
function safeGetGlobals(): { json: boolean } {
  try {
    return getGlobals();
  } catch {
    return { json: false };
  }
}

/**
 * Show resolved skill paths.
 */
export async function showPaths(opts: PathsOptions = {}): Promise<void> {
  const scope = opts.scope ?? 'all';
  const target = opts.target ?? 'all';
  const globals = safeGetGlobals();
  const json = opts.json ?? globals.json;

  const resolved = resolveAllPaths(scope, target, {
    cwd: opts.cwd,
    homeDir: opts.homeDir,
  });

  const results: PathInfo[] = [];

  for (const r of resolved) {
    const skillMdPath = join(r.paths.gnoDir, 'SKILL.md');
    const exists = await Bun.file(skillMdPath).exists();
    results.push({
      target: r.target,
      scope: r.scope,
      path: r.paths.gnoDir,
      exists,
    });
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({ paths: results }, null, 2)}\n`);
  } else {
    process.stdout.write('GNO Skill Paths:\n\n');
    for (const r of results) {
      const status = r.exists ? '(installed)' : '(not installed)';
      process.stdout.write(`  ${r.target}/${r.scope}: ${r.path} ${status}\n`);
    }
  }
}
