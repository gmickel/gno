/**
 * Path resolution for skill installation.
 * Supports Claude Code and Codex targets with project/user scopes.
 *
 * @module src/cli/commands/skill/paths
 */

import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// Environment Variables
// ─────────────────────────────────────────────────────────────────────────────

/** Override home dir for user scope (testing) */
export const ENV_SKILLS_HOME_OVERRIDE = 'GNO_SKILLS_HOME_OVERRIDE';

/** Override Claude skills directory */
export const ENV_CLAUDE_SKILLS_DIR = 'CLAUDE_SKILLS_DIR';

/** Override Codex skills directory */
export const ENV_CODEX_SKILLS_DIR = 'CODEX_SKILLS_DIR';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SkillScope = 'project' | 'user';
export type SkillTarget = 'claude' | 'codex';

export interface SkillPathOptions {
  scope: SkillScope;
  target: SkillTarget;
  /** Override cwd for project scope (testing) */
  cwd?: string;
  /** Override home dir for user scope (testing) */
  homeDir?: string;
}

export interface SkillPaths {
  /** Base directory (e.g., ~/.claude or ./.claude) */
  base: string;
  /** Skills directory (e.g., ~/.claude/skills) */
  skillsDir: string;
  /** GNO skill directory (e.g., ~/.claude/skills/gno) */
  gnoDir: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Skill name for the gno skill directory */
export const SKILL_NAME = 'gno';

/** Directory name for skills within agent config */
const SKILLS_SUBDIR = 'skills';

/** Agent config directory names */
const AGENT_DIRS: Record<SkillTarget, string> = {
  claude: '.claude',
  codex: '.codex',
};

// ─────────────────────────────────────────────────────────────────────────────
// Path Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve skill installation paths for a given scope and target.
 */
export function resolveSkillPaths(opts: SkillPathOptions): SkillPaths {
  const { scope, target, cwd, homeDir } = opts;

  // Check for env overrides first
  const envOverride =
    target === 'claude'
      ? process.env[ENV_CLAUDE_SKILLS_DIR]
      : process.env[ENV_CODEX_SKILLS_DIR];

  if (envOverride) {
    // Require absolute path for security
    if (!isAbsolute(envOverride)) {
      throw new Error(
        `${target === 'claude' ? ENV_CLAUDE_SKILLS_DIR : ENV_CODEX_SKILLS_DIR} must be an absolute path`
      );
    }
    const skillsDir = normalize(envOverride);
    return {
      base: join(skillsDir, '..'),
      skillsDir,
      gnoDir: join(skillsDir, SKILL_NAME),
    };
  }

  // Resolve base directory
  const agentDir = AGENT_DIRS[target];
  let base: string;

  if (scope === 'user') {
    const home = homeDir ?? process.env[ENV_SKILLS_HOME_OVERRIDE] ?? homedir();
    base = join(home, agentDir);
  } else {
    const projectRoot = cwd ?? process.cwd();
    base = join(projectRoot, agentDir);
  }

  const skillsDir = join(base, SKILLS_SUBDIR);
  const gnoDir = join(skillsDir, SKILL_NAME);

  return { base, skillsDir, gnoDir };
}

/**
 * Resolve paths for all targets given scope options.
 */
export function resolveAllPaths(
  scope: SkillScope | 'all',
  target: SkillTarget | 'all',
  overrides?: { cwd?: string; homeDir?: string }
): Array<{ scope: SkillScope; target: SkillTarget; paths: SkillPaths }> {
  const scopes: SkillScope[] = scope === 'all' ? ['project', 'user'] : [scope];
  const targets: SkillTarget[] =
    target === 'all' ? ['claude', 'codex'] : [target];

  const results: Array<{
    scope: SkillScope;
    target: SkillTarget;
    paths: SkillPaths;
  }> = [];

  for (const s of scopes) {
    for (const t of targets) {
      results.push({
        scope: s,
        target: t,
        paths: resolveSkillPaths({ scope: s, target: t, ...overrides }),
      });
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Safety Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Expected path suffix for gno skill directory.
 * Platform-aware (handles Windows backslash).
 */
function getExpectedSuffix(): string {
  return `${sep}${SKILLS_SUBDIR}${sep}${SKILL_NAME}`;
}

/**
 * Validate that a path is safe to delete.
 * Returns null if safe, or error message if unsafe.
 */
export function validatePathForDeletion(
  destDir: string,
  base: string
): string | null {
  const normalized = normalize(destDir);
  const normalizedBase = normalize(base);
  const expectedSuffix = getExpectedSuffix();

  // Must end with /skills/gno (or \skills\gno on Windows)
  if (!normalized.endsWith(expectedSuffix)) {
    return `Path does not end with expected suffix (${expectedSuffix})`;
  }

  // Minimum length sanity check
  if (normalized.length < 20) {
    return 'Path is suspiciously short';
  }

  // Must not equal base
  if (normalized === normalizedBase) {
    return 'Path equals base directory';
  }

  // Must be strictly inside expected base (proper containment check)
  const rel = relative(normalizedBase, normalized);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return 'Path is not inside expected base directory';
  }

  return null;
}
