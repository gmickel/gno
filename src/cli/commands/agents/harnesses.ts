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

// node:fs: detection needs synchronous stat/realpath (symlink-aware identity)
// with no Bun equivalent.
import { existsSync, realpathSync, statSync } from "node:fs";
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
  /** Instruction file: inside the config dir, or directly under home. */
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
}

const HARNESS_DEFS: Record<HarnessId, HarnessDef> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    configDir: ".claude",
    instructionFile: { dir: "config", name: "CLAUDE.md" },
    configDirEnvVar: "CLAUDE_CONFIG_DIR",
  },
  codex: {
    id: "codex",
    label: "Codex",
    configDir: ".codex",
    instructionFile: { dir: "config", name: "AGENTS.md" },
    configDirEnvVar: "CODEX_HOME",
  },
  cursor: {
    id: "cursor",
    label: "Cursor Agent",
    configDir: ".cursor",
    // Cursor Agent discovers AGENTS.md walking from the working directory
    // towards the home directory; ~/AGENTS.md is its user-global surface.
    instructionFile: { dir: "home", name: "AGENTS.md" },
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    configDir: ".config/opencode",
    instructionFile: { dir: "config", name: "AGENTS.md" },
  },
  grok: {
    id: "grok",
    label: "Grok Build",
    configDir: ".grok",
    // Grok imports the Claude global instruction file — no file of its own;
    // `coveredBy` makes resolution report Claude's file for it.
    instructionFile: { dir: "config", name: "AGENTS.md" },
    coveredBy: "claude",
  },
  hermes: {
    id: "hermes",
    label: "Hermes",
    configDir: ".hermes",
    instructionFile: { dir: "config", name: "SOUL.md" },
  },
  openclaw: {
    id: "openclaw",
    label: "OpenClaw",
    configDir: ".openclaw/workspace",
    instructionFile: { dir: "config", name: "AGENTS.md" },
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
  /** Real (symlink-resolved) identity of the file, for dedupe + writes. */
  realFile: string;
  /** Whether the harness is detected on this machine. */
  detected: boolean;
  /** Import chain target this harness is covered by, when applicable. */
  coveredBy?: HarnessId;
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

/**
 * Symlink-resolved identity of an instruction file. An existing file resolves
 * fully (so a canonical file linked into several harnesses is written once,
 * through the link); a file that does not exist yet resolves its parent dir,
 * so two harnesses whose config dirs are links to one place still share an
 * identity. Anything unresolvable falls back to the normalized path.
 */
export function realIdentity(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    const normalized = normalize(file);
    try {
      return join(realpathSync(dirname(normalized)), basename(normalized));
    } catch {
      return normalized;
    }
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
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

  // A covered harness (grok → claude) reads its covering harness's file and
  // has none of its own, so that is the file its rows report.
  const file = def.coveredBy
    ? resolveHarness(HARNESS_DEFS[def.coveredBy], home, explicitHome).file
    : def.instructionFile.dir === "home"
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
  return {
    id: "extra-dir",
    label: `extra dir ${abs}`,
    configDir: abs,
    file,
    realFile: realIdentity(file),
    detected: true,
  };
}

/** Covering chain for an explicit target (e.g. grok → claude), covering first. */
function coveringChain(id: HarnessId): HarnessId[] {
  const chain: HarnessId[] = [];
  let cursor = HARNESS_DEFS[id].coveredBy;
  while (cursor && !chain.includes(cursor) && cursor !== id) {
    chain.unshift(cursor);
    cursor = HARNESS_DEFS[cursor].coveredBy;
  }
  return chain;
}

/**
 * Resolve all requested targets to concrete instruction files.
 * `target: "all"` = every supported harness (detection filters at plan time).
 * An explicit covered target (e.g. `grok`) also resolves its covering
 * target(s) so the file it actually reads is planned/verified — but only when
 * the requested target itself is detected; an absent one is reported
 * `not-detected` without touching the covering harness's file.
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
  const one = (id: HarnessId): ResolvedTarget =>
    resolveHarness(HARNESS_DEFS[id], home, explicitHome);

  let results: ResolvedTarget[];
  if (target === "all") {
    results = HARNESS_IDS.map(one);
  } else {
    const leaf = one(target);
    results = leaf.detected
      ? [...coveringChain(target).map(one), leaf]
      : [leaf];
  }

  for (const dir of opts.extraDirs ?? []) {
    results.push(resolveExtraDir(dir));
  }
  return results;
}
