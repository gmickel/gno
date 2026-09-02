/**
 * Path resolution for skill installation.
 * Supports Claude Code, Codex, OpenCode, OpenClaw, and Hermes targets with project/user scopes.
 *
 * @module src/cli/commands/skill/paths
 */

// node:fs is used here because Bun has no realpath/lstat equivalent for
// validating symlink-aware deletion containment before recursive rm.
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

import { CliError } from "../../errors.js";

// ─────────────────────────────────────────────────────────────────────────────
// Environment Variables
// ─────────────────────────────────────────────────────────────────────────────

/** Override home dir for user scope (testing) */
export const ENV_SKILLS_HOME_OVERRIDE = "GNO_SKILLS_HOME_OVERRIDE";

/** Override Claude skills directory */
export const ENV_CLAUDE_SKILLS_DIR = "CLAUDE_SKILLS_DIR";

/** Override Codex skills directory */
export const ENV_CODEX_SKILLS_DIR = "CODEX_SKILLS_DIR";

/** Override OpenCode skills directory */
export const ENV_OPENCODE_SKILLS_DIR = "OPENCODE_SKILLS_DIR";

/** Override OpenClaw skills directory */
export const ENV_OPENCLAW_SKILLS_DIR = "OPENCLAW_SKILLS_DIR";

/** Override Hermes skills directory */
export const ENV_HERMES_SKILLS_DIR = "HERMES_SKILLS_DIR";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SkillScope = "project" | "user";
export type SkillTarget =
  | "claude"
  | "codex"
  | "opencode"
  | "openclaw"
  | "hermes";

export const SKILL_TARGETS: SkillTarget[] = [
  "claude",
  "codex",
  "opencode",
  "openclaw",
  "hermes",
];

export interface SkillPathOptions {
  scope: SkillScope;
  target: SkillTarget;
  /** Override cwd for project scope (testing) */
  cwd?: string;
  /** Override home dir for user scope (testing) */
  homeDir?: string;
  /**
   * Explicit skills directory (the `--skills-dir` CLI option). Wins over every
   * env-derived location — the portable way to address a nonstandard harness
   * instance (`<instance>/skills`) without shell-specific env syntax.
   */
  skillsDir?: string;
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
export const SKILL_NAME = "gno";

/** Path configuration per target */
interface TargetPathConfig {
  projectBase: string; // e.g., ".claude"
  userBase: string; // e.g., ".claude" (joined with homedir) or ".config/opencode"
  skillsSubdir: string; // e.g., "skills" or "skill"
  envVar: string;
  /**
   * The harness's own documented config-dir override (e.g. CODEX_HOME). User
   * scope resolves under it so a redirected harness instance finds the skill
   * where it actually loads skills from. Less specific than `envVar`, and
   * suppressed by an explicit homeDir / GNO_SKILLS_HOME_OVERRIDE (isolation).
   */
  configDirEnvVar?: string;
}

const TARGET_CONFIGS: Record<SkillTarget, TargetPathConfig> = {
  claude: {
    projectBase: ".claude",
    userBase: ".claude",
    skillsSubdir: "skills",
    envVar: ENV_CLAUDE_SKILLS_DIR,
    configDirEnvVar: "CLAUDE_CONFIG_DIR",
  },
  codex: {
    projectBase: ".codex",
    userBase: ".codex",
    skillsSubdir: "skills",
    envVar: ENV_CODEX_SKILLS_DIR,
    configDirEnvVar: "CODEX_HOME",
  },
  opencode: {
    projectBase: ".opencode",
    userBase: ".config/opencode",
    skillsSubdir: "skills",
    envVar: ENV_OPENCODE_SKILLS_DIR,
  },
  openclaw: {
    projectBase: ".openclaw",
    userBase: ".openclaw",
    skillsSubdir: "skills",
    envVar: ENV_OPENCLAW_SKILLS_DIR,
  },
  hermes: {
    projectBase: ".hermes",
    userBase: ".hermes",
    skillsSubdir: "skills",
    envVar: ENV_HERMES_SKILLS_DIR,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Path Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve skill installation paths for a given scope and target.
 */
export function resolveSkillPaths(opts: SkillPathOptions): SkillPaths {
  const { scope, target, cwd, homeDir } = opts;
  const config = TARGET_CONFIGS[target];

  // An explicit --skills-dir wins over everything (CLI beats env).
  if (opts.skillsDir !== undefined) {
    if (!isAbsolute(opts.skillsDir)) {
      // Invalid CLI operand → exit 1 (validation), not a runtime failure.
      throw new CliError("VALIDATION", "--skills-dir must be an absolute path");
    }
    const skillsDir = normalize(opts.skillsDir);
    return {
      base: join(skillsDir, ".."),
      skillsDir,
      gnoDir: join(skillsDir, SKILL_NAME),
    };
  }

  // Check for env overrides first
  const envOverride = process.env[config.envVar];

  if (envOverride) {
    // Require absolute path for security
    if (!isAbsolute(envOverride)) {
      throw new CliError(
        "VALIDATION",
        `${config.envVar} must be an absolute path`
      );
    }
    const skillsDir = normalize(envOverride);
    return {
      base: join(skillsDir, ".."),
      skillsDir,
      gnoDir: join(skillsDir, SKILL_NAME),
    };
  }

  // Resolve base directory
  let base: string;

  if (scope === "user") {
    // An explicit home (option or GNO_SKILLS_HOME_OVERRIDE) is an isolation
    // request and suppresses the harness config-dir redirect — the same rule
    // the agents installer applies to the instruction file.
    const isolated =
      homeDir !== undefined ||
      process.env[ENV_SKILLS_HOME_OVERRIDE] !== undefined;
    const configOverride =
      !isolated && config.configDirEnvVar
        ? process.env[config.configDirEnvVar]
        : undefined;
    if (configOverride) {
      if (!isAbsolute(configOverride)) {
        throw new CliError(
          "VALIDATION",
          `${config.configDirEnvVar} must be an absolute path`
        );
      }
      base = normalize(configOverride);
    } else {
      const home =
        homeDir ?? process.env[ENV_SKILLS_HOME_OVERRIDE] ?? homedir();
      base = join(home, config.userBase);
    }
  } else {
    const projectRoot = cwd ?? process.cwd();
    base = join(projectRoot, config.projectBase);
  }

  const skillsDir = join(base, config.skillsSubdir);
  const gnoDir = join(skillsDir, SKILL_NAME);

  return { base, skillsDir, gnoDir };
}

/**
 * Resolve paths for all targets given scope options.
 */
export function resolveAllPaths(
  scope: SkillScope | "all",
  target: SkillTarget | "all",
  overrides?: { cwd?: string; homeDir?: string }
): Array<{ scope: SkillScope; target: SkillTarget; paths: SkillPaths }> {
  const scopes: SkillScope[] = scope === "all" ? ["project", "user"] : [scope];
  const targets: SkillTarget[] = target === "all" ? SKILL_TARGETS : [target];

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
 * Get expected path suffixes for gno skill directory.
 * Returns all valid suffixes since different targets use different subdir names.
 */
function getExpectedSuffixes(): string[] {
  const subdirs = new Set(
    Object.values(TARGET_CONFIGS).map((c) => c.skillsSubdir)
  );
  return Array.from(subdirs).map(
    (subdir) => `${sep}${subdir}${sep}${SKILL_NAME}`
  );
}

/**
 * Validate that a path is safe to delete.
 * Returns null if safe, or error message if unsafe.
 */
export function validatePathForDeletion(
  destDir: string,
  base: string,
  expectedDir?: string
): string | null {
  const normalized = normalize(destDir);
  const normalizedBase = normalize(base);
  const normalizedExpected = expectedDir ? normalize(expectedDir) : undefined;
  const expectedSuffixes = getExpectedSuffixes();

  // Must be the resolved target directory, or end with a known skill suffix.
  // The exact resolved path covers absolute skills-dir env overrides.
  const matchesExpectedDir = normalizedExpected === normalized;
  const hasValidSuffix = expectedSuffixes.some((suffix) =>
    normalized.endsWith(suffix)
  );
  if (!(matchesExpectedDir || hasValidSuffix)) {
    return `Path does not end with expected suffix (${expectedSuffixes.join(" or ")})`;
  }

  // Minimum length sanity check — a heuristic against deleting a near-root
  // path when only the suffix matched. An explicit resolved destination
  // (`--skills-dir` / env override, passed as expectedDir) is already exact:
  // it carries the `<skills>/<name>` structure and is containment-checked
  // below, so a short but legitimate `/tmp/x/skills/gno` must stay removable
  // (the documented matching removal path; also what makes the generated
  // `--force` remediation idempotent).
  if (!matchesExpectedDir && normalized.length < 20) {
    return "Path is suspiciously short";
  }
  // Structural guard that does not depend on total length: the skill dir is
  // always `<something>/<skills>/<name>`, so a resolved destination with fewer
  // than three path segments (e.g. `/skills/gno`) sits next to the filesystem
  // root and is never a legitimate target.
  const depth = normalized.split(sep).filter(Boolean).length;
  if (depth < 3) {
    return "Path is too close to the filesystem root";
  }

  // Must not equal base
  if (normalized === normalizedBase) {
    return "Path equals base directory";
  }

  // Must be strictly inside expected base (proper containment check)
  const rel = relative(normalizedBase, normalized);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return "Path is not inside expected base directory";
  }

  const parentDir = dirname(normalized);
  if (existsSync(parentDir) && existsSync(normalizedBase)) {
    try {
      const realBase = realpathSync(normalizedBase);
      const realParent = realpathSync(parentDir);
      const realRel = relative(realBase, realParent);
      if (realRel.startsWith("..") || isAbsolute(realRel)) {
        return "Path resolves outside expected base directory";
      }
    } catch (err) {
      return `Path realpath check failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return null;
}
