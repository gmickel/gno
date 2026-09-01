/**
 * Harness matrix for `gno agents`: which global (user-scope) instruction
 * file each supported harness reads, how the harness is detected, and which
 * import chains make a separate install redundant.
 *
 * Discovery is standard documented locations only — nonstandard/multi-
 * instance layouts are served by the explicit `--extra-dir` flag, never by
 * guessed discovery.
 *
 * @module src/cli/commands/agents/harnesses
 */

// node:fs is used because detection needs synchronous lstat/realpath checks
// (symlink-aware identity) with no Bun equivalent.
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";

import { CliError } from "../../errors.js";
import { resolveSkillPaths, type SkillTarget } from "../skill/paths.js";

// ─────────────────────────────────────────────────────────────────────────────
// Environment Variables
// ─────────────────────────────────────────────────────────────────────────────

/** Override home dir for testing / sandboxed live verification. */
export const ENV_AGENTS_HOME_OVERRIDE = "GNO_AGENTS_HOME_OVERRIDE";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type HarnessId =
  | "claude"
  | "codex"
  | "cursor"
  | "opencode"
  | "grok"
  | "hermes"
  | "openclaw";

export const HARNESS_IDS: HarnessId[] = [
  "claude",
  "codex",
  "cursor",
  "opencode",
  "grok",
  "hermes",
  "openclaw",
];

interface HarnessDef {
  id: HarnessId;
  label: string;
  /** Harness config dir (detection root), relative to home. */
  configDir: string;
  /** Instruction file path relative to home ("" dir means configDir). */
  instructionFile: { dir: "config" | "home"; name: string };
  /**
   * Env var naming the harness's documented config-dir override
   * (honored only when no explicit homeDir override is active).
   */
  configDirEnvVar?: string;
  /**
   * Import chain: this harness reads another harness's instruction file, so
   * a separate install would double the block. Data-driven so future chains
   * are matrix entries, not code changes.
   */
  coveredBy?: HarnessId;
  /** Skill target used for the state-aware skill pointer in the block. */
  skillTarget: SkillTarget;
}

const HARNESS_DEFS: Record<HarnessId, HarnessDef> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    configDir: ".claude",
    instructionFile: { dir: "config", name: "CLAUDE.md" },
    configDirEnvVar: "CLAUDE_CONFIG_DIR",
    skillTarget: "claude",
  },
  codex: {
    id: "codex",
    label: "Codex",
    configDir: ".codex",
    instructionFile: { dir: "config", name: "AGENTS.md" },
    configDirEnvVar: "CODEX_HOME",
    skillTarget: "codex",
  },
  cursor: {
    id: "cursor",
    label: "Cursor Agent",
    configDir: ".cursor",
    // Cursor Agent discovers AGENTS.md walking from the working directory
    // towards the home directory; ~/AGENTS.md is its user-global surface.
    instructionFile: { dir: "home", name: "AGENTS.md" },
    // Cursor reads .claude/skills in addition to its own; the skill
    // installer has no dedicated cursor target.
    skillTarget: "claude",
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    configDir: ".config/opencode",
    instructionFile: { dir: "config", name: "AGENTS.md" },
    skillTarget: "opencode",
  },
  grok: {
    id: "grok",
    label: "Grok Build",
    configDir: ".grok",
    // Grok imports the Claude global instruction file — no file of its own.
    instructionFile: { dir: "config", name: "AGENTS.md" },
    coveredBy: "claude",
    skillTarget: "claude",
  },
  hermes: {
    id: "hermes",
    label: "Hermes",
    configDir: ".hermes",
    instructionFile: { dir: "config", name: "SOUL.md" },
    skillTarget: "hermes",
  },
  openclaw: {
    id: "openclaw",
    label: "OpenClaw",
    configDir: ".openclaw/workspace",
    instructionFile: { dir: "config", name: "AGENTS.md" },
    skillTarget: "openclaw",
  },
};

export interface ResolvedTarget {
  /** Harness id, or "extra-dir" for explicit --extra-dir paths. */
  id: HarnessId | "extra-dir";
  label: string;
  /** Detection root (harness config dir, or the extra dir itself). */
  configDir: string;
  /** Absolute path to the instruction file the harness reads. */
  file: string;
  /** Real (symlink-resolved) identity of the file, for dedupe grouping. */
  realFile: string;
  /** Whether the harness is detected on this machine. */
  detected: boolean;
  /** Import chain target this harness is covered by, when applicable. */
  coveredBy?: HarnessId;
  /** Whether the GNO agent skill is installed for this harness (user scope). */
  skillInstalled: boolean;
}

export interface ResolveOptions {
  /** Explicit home override (testing / sandboxed verification). When set,
   *  harness config-dir env overrides are ignored for determinism. */
  homeDir?: string;
  /** Explicit extra instruction dirs (nonstandard/multi-instance layouts). */
  extraDirs?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

function realIdentity(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return normalize(file);
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function skillInstalledFor(target: SkillTarget, homeDir: string): boolean {
  try {
    const paths = resolveSkillPaths({ scope: "user", target, homeDir });
    return existsSync(join(paths.gnoDir, "SKILL.md"));
  } catch {
    return false;
  }
}

function resolveHarness(
  def: HarnessDef,
  home: string,
  explicitHome: boolean
): ResolvedTarget {
  let configDir = join(home, def.configDir);

  if (!explicitHome && def.configDirEnvVar) {
    const envOverride = process.env[def.configDirEnvVar];
    if (envOverride) {
      if (!isAbsolute(envOverride)) {
        throw new CliError(
          "VALIDATION",
          `${def.configDirEnvVar} must be an absolute path`
        );
      }
      configDir = normalize(envOverride);
    }
  }

  const file =
    def.instructionFile.dir === "home"
      ? join(home, def.instructionFile.name)
      : join(configDir, def.instructionFile.name);

  return {
    id: def.id,
    label: def.label,
    configDir,
    file,
    realFile: realIdentity(file),
    detected: isDirectory(configDir),
    coveredBy: def.coveredBy,
    skillInstalled: skillInstalledFor(def.skillTarget, home),
  };
}

/** Instruction file candidates for --extra-dir, in priority order. */
const EXTRA_DIR_FILE_CANDIDATES = ["CLAUDE.md", "AGENTS.md", "SOUL.md"];
const DEFAULT_EXTRA_DIR_FILE = "AGENTS.md";

function resolveExtraDir(dir: string, home: string): ResolvedTarget {
  const abs = resolve(dir);
  if (!isDirectory(abs)) {
    throw new CliError(
      "VALIDATION",
      `--extra-dir ${dir} does not exist or is not a directory. The installer never fabricates harness directories.`
    );
  }
  const existing = EXTRA_DIR_FILE_CANDIDATES.find((name) =>
    existsSync(join(abs, name))
  );
  const file = join(abs, existing ?? DEFAULT_EXTRA_DIR_FILE);
  // Extra dirs are nonstandard by definition; use any-harness skill presence.
  const skillInstalled = (
    ["claude", "codex", "opencode", "openclaw", "hermes"] as SkillTarget[]
  ).some((t) => skillInstalledFor(t, home));

  return {
    id: "extra-dir",
    label: `extra dir ${abs}`,
    configDir: abs,
    file,
    realFile: realIdentity(file),
    detected: true,
    skillInstalled,
  };
}

/**
 * Expand an explicit target to include its covering chain (e.g. grok →
 * claude), covering targets first. "Covered via X" is only truthful when X
 * itself is resolved and converged in the same run, so an explicit covered
 * target always pulls its covering target(s) into the run.
 */
function withCoveringChain(id: HarnessId): HarnessId[] {
  const chain: HarnessId[] = [id];
  let cursor = HARNESS_DEFS[id].coveredBy;
  while (cursor && !chain.includes(cursor)) {
    chain.unshift(cursor);
    cursor = HARNESS_DEFS[cursor].coveredBy;
  }
  return chain;
}

/**
 * Resolve all requested targets to concrete instruction files.
 * `target: "all"` = every supported harness (detection filters at plan time).
 * An explicit covered target (e.g. `grok`) also resolves its covering
 * target(s) so the covering instruction file is actually planned/verified.
 */
export function resolveTargets(
  target: HarnessId | "all",
  opts: ResolveOptions = {}
): ResolvedTarget[] {
  // Any home override (option or env) suppresses harness config-dir env
  // overrides too — an overridden home is an isolation request.
  const explicitHome =
    opts.homeDir !== undefined ||
    process.env[ENV_AGENTS_HOME_OVERRIDE] !== undefined;
  const home =
    opts.homeDir ?? process.env[ENV_AGENTS_HOME_OVERRIDE] ?? homedir();

  const ids: HarnessId[] =
    target === "all" ? HARNESS_IDS : withCoveringChain(target);
  const results = ids.map((id) =>
    resolveHarness(HARNESS_DEFS[id], home, explicitHome)
  );

  for (const dir of opts.extraDirs ?? []) {
    results.push(resolveExtraDir(dir, home));
  }

  return results;
}
