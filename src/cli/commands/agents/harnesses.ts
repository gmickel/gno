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
import {
  existsSync,
  lstatSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  resolve,
} from "node:path";

import { CliError } from "../../errors.js";
import {
  resolveSkillPaths,
  SKILL_NAME,
  type SkillTarget,
} from "../skill/paths.js";

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
  /** Skill target this consumer loads the GNO skill from. */
  skillTarget: SkillTarget;
  /**
   * Set when this consumer loads ANOTHER harness's skill from that harness's
   * standard config dir while that harness itself is redirected by env (e.g.
   * Cursor reads `~/.claude/skills` even when `CLAUDE_CONFIG_DIR` points
   * elsewhere): the standard config dir the remediation must install into.
   */
  skillHome?: string;
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
  /**
   * Drop harnesses whose resolution throws (misconfigured env) instead of
   * aborting — for the skill-state aggregation universe, where unrequested
   * harnesses must not be able to fail an explicit-target run. Extra dirs
   * are always strict (they are explicitly requested).
   */
  lenient?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

function realIdentity(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    // The file does not exist yet. First follow the leaf itself while it is a
    // (dangling) symlink: two harness files linked to the same missing shared
    // target must converge on that target's identity, not on their distinct
    // link names. Then resolve the nearest existing ancestor so targets
    // reaching the same not-yet-created file through different symlinked
    // parent dirs still share one identity — otherwise planTargets misses the
    // dedupe and the second (backup-less) install write clobbers the first.
    const normalized = followDanglingSymlinks(normalize(file));
    let ancestor = dirname(normalized);
    const trailing: string[] = [basename(normalized)];
    while (!existsSync(ancestor)) {
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        break;
      }
      trailing.unshift(basename(ancestor));
      ancestor = parent;
    }
    try {
      return join(realpathSync(ancestor), ...trailing);
    } catch {
      return normalized;
    }
  }
}

/** Bound on symlink hops — mirrors the kernel's ELOOP guard. */
const MAX_SYMLINK_HOPS = 40;

/**
 * Follow a chain of symlinks whose final destination may not exist yet.
 * Stops at the first non-symlink path component (existing or absent) or at
 * the hop bound; a cycle simply exhausts the bound and returns the last path.
 */
function followDanglingSymlinks(path: string): string {
  let current = path;
  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
    let link: string;
    try {
      if (!lstatSync(current).isSymbolicLink()) {
        return current;
      }
      link = readlinkSync(current);
    } catch {
      return current; // absent (not a symlink) or unreadable — nothing to follow
    }
    current = normalize(isAbsolute(link) ? link : join(dirname(current), link));
  }
  return current;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where a harness's skill state is read from. A harness that owns its skill
 * target (claude→claude, codex→codex) follows that target's config-dir env
 * redirect; a CONSUMER of another harness's skill (cursor/grok → claude) loads
 * it from the standard location and must be checked there regardless of the
 * redirect — otherwise a skill present only in a redirected Claude instance
 * would make Cursor's block advertise `/gno` it cannot load. Returns the
 * `resolveSkillPaths` location plus the standard config dir when the consumer
 * is decoupled from an active redirect (the remediation must target it).
 */
export function skillStateLocation(
  id: HarnessId,
  home: string,
  explicitHome: boolean
): { target: SkillTarget; homeDir?: string; skillHome?: string } {
  const def = HARNESS_DEFS[id];
  const target = def.skillTarget;
  const ownsSkillTarget = id === target;
  if (ownsSkillTarget) {
    return { target, homeDir: explicitHome ? home : undefined };
  }
  // Consumer: always the standard location (explicit home suppresses env).
  const skillDef = HARNESS_DEFS[target as HarnessId];
  const redirectActive =
    !explicitHome &&
    skillDef?.configDirEnvVar !== undefined &&
    process.env[skillDef.configDirEnvVar] !== undefined;
  return {
    target,
    homeDir: home,
    ...(redirectActive &&
      skillDef && { skillHome: join(home, skillDef.configDir) }),
  };
}

function skillInstalledFor(
  target: SkillTarget,
  homeDir: string,
  explicitHome: boolean
): boolean {
  try {
    // Skill state is derived from the SAME effective config dir the
    // instruction file resolves under: resolveSkillPaths honors the harness
    // config-dir env override (CODEX_HOME, CLAUDE_CONFIG_DIR) for user scope,
    // with the dedicated skills-dir env var still winning. Passing an explicit
    // homeDir suppresses those redirects — the same isolation rule
    // resolveHarness applies to the instruction file — so only forward it
    // when a home override is active.
    const paths = resolveSkillPaths({
      scope: "user",
      target,
      homeDir: explicitHome ? homeDir : undefined,
    });
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

  const location = skillStateLocation(def.id, home, explicitHome);
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
    skillInstalled: skillInstalledFor(
      location.target,
      home,
      location.homeDir !== undefined
    ),
    skillTarget: def.skillTarget,
    ...(location.skillHome !== undefined && { skillHome: location.skillHome }),
  };
}

/** Instruction file candidates for --extra-dir, in priority order. */
const EXTRA_DIR_FILE_CANDIDATES = ["CLAUDE.md", "AGENTS.md", "SOUL.md"];
const DEFAULT_EXTRA_DIR_FILE = "AGENTS.md";

function resolveExtraDir(dir: string): ResolvedTarget {
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
  // An extra dir is a harness instance of its own: the skill it can load is
  // the one under ITS config dir (<dir>/skills/gno), never a standard
  // harness's. Operators install into an instance via the dedicated
  // skills-dir env override (e.g. CLAUDE_SKILLS_DIR=<dir>/skills).
  const skillInstalled = existsSync(
    join(abs, "skills", SKILL_NAME, "SKILL.md")
  );

  return {
    id: "extra-dir",
    label: `extra dir ${abs}`,
    configDir: abs,
    file,
    realFile: realIdentity(file),
    detected: true,
    skillInstalled,
    // Instances share the skills/<name> layout of every target; claude is the
    // env-override vehicle (CLAUDE_SKILLS_DIR) the remediation uses.
    skillTarget: "claude",
  };
}

/**
 * Expand an explicit target to include its covering chain (e.g. grok →
 * claude), covering targets first. "Covered via X" is only truthful when X
 * itself is resolved and converged in the same run, so an explicit *detected*
 * covered target pulls its covering target(s) into the run (resolveTargets
 * drops the chain again when the requested leaf turns out to be absent).
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
 * target(s) so the covering instruction file is actually planned/verified —
 * but only when the requested target itself is detected. An absent explicit
 * target resolves to just itself (reported `not-detected` at plan time), so
 * the run never touches the covering harness's file on its behalf.
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
  let results = ids.flatMap((id) => {
    try {
      return [resolveHarness(HARNESS_DEFS[id], home, explicitHome)];
    } catch (err) {
      // Lenient resolution (skill-state aggregation universe): a harness the
      // operator did not request must not abort the run because ITS env is
      // misconfigured (e.g. a relative CLAUDE_CONFIG_DIR) — drop it from the
      // aggregation instead. Requested targets stay strict.
      if (opts.lenient) {
        return [];
      }
      throw err;
    }
  });

  if (target !== "all") {
    // The covering chain is only truthful for a target that is actually
    // present. An absent explicit target must not pull its covering
    // harness(es) into the run — otherwise `--target grok` on a machine
    // without ~/.grok would install into / verify against / uninstall from
    // Claude's file. Resolve just the leaf so it reports `not-detected`.
    const leaf = results.find((t) => t.id === target);
    if (leaf && !leaf.detected) {
      results = [leaf];
    }
  }

  for (const dir of opts.extraDirs ?? []) {
    results.push(resolveExtraDir(dir));
  }

  return results;
}
