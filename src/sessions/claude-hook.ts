/**
 * Claude Code SessionEnd hook: owned-entry install, removal and inspection.
 *
 * GNO edits only the one hook entry it owns in a Claude Code settings file.
 * Ownership is the command itself: it runs `sessions hook claude-code` for
 * one archive config and profile, so foreign hooks (including other GNO
 * profiles) are never touched. A settings file that is not valid JSON, or
 * whose `hooks` shape is unexpected, is left unchanged. Writes keep a `.bak`
 * copy and replace the file atomically (the MCP installer's contract).
 *
 * @module src/sessions/claude-hook
 */

// node:os homedir: no Bun equivalent.
import { homedir } from "node:os";
// node:path: no Bun path utilities.
import { join, resolve } from "node:path";

import { resolveDirs } from "../app/constants";
import {
  readMcpConfigText,
  writeMcpConfigText,
} from "../cli/commands/mcp/config";
import { findBunPath } from "../cli/commands/mcp/paths";
import { getCurrentGnoEntrypoint } from "../core/runtime-entrypoint";
import { canonicalConfigPath } from "./binding";
import { SessionsError } from "./types";

/**
 * Ownership is keyed on the canonical archive config path, so a symlinked
 * path (for example macOS `/var` -> `/private/var`) matches its entry.
 */
async function canonicalIdentity(
  identity: HookIdentity
): Promise<HookIdentity> {
  return {
    ...identity,
    configPath: await canonicalConfigPath(identity.configPath),
  };
}

/**
 * Claude Code's hook `timeout` (seconds). SessionEnd hooks otherwise share a
 * 1.5 s budget; the hook itself returns after at most the admission deadline.
 */
export const CLAUDE_HOOK_TIMEOUT_SECONDS = 5;

export interface HookIdentity {
  configPath: string;
  indexName: string;
  profileId: string;
}

/** `$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`. */
export function defaultClaudeSettingsPath(
  env: NodeJS.ProcessEnv = process.env
): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  return join(resolve(dir), "settings.json");
}

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const ownedSuffix = (identity: HookIdentity): string =>
  `sessions hook claude-code --profile ${quote(identity.profileId)}`;

/**
 * The absolute command the hook runs: this GNO runtime, its data/cache
 * directories, and the archive config/index pair, so neither PATH nor the
 * session's working directory can redirect it.
 */
export function buildClaudeHookCommand(identity: HookIdentity): string {
  const dirs = resolveDirs();
  return [
    `GNO_DATA_DIR=${quote(resolve(dirs.data))}`,
    `GNO_CACHE_DIR=${quote(resolve(dirs.cache))}`,
    quote(findBunPath()),
    "run",
    quote(getCurrentGnoEntrypoint()),
    "--config",
    quote(resolve(identity.configPath)),
    "--index",
    quote(identity.indexName),
    ownedSuffix(identity),
  ].join(" ");
}

/** Owned by this config and profile, whatever runtime path it was built with. */
export function isOwnedHookCommand(
  command: unknown,
  identity: HookIdentity
): boolean {
  return (
    typeof command === "string" &&
    command.includes(`--config ${quote(resolve(identity.configPath))} `) &&
    command.endsWith(ownedSuffix(identity))
  );
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const unexpected = (path: string, detail: string): SessionsError =>
  new SessionsError(
    "SESSIONS_INVALID_INPUT",
    `Claude Code settings ${path} ${detail}; nothing was changed. Fix the file, then retry.`
  );

async function readSettings(path: string): Promise<Json | null> {
  const text = await readMcpConfigText(path, { returnNullOnMissing: true });
  if (text === null) return null;
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw unexpected(path, "is not valid JSON");
  }
  if (!isObject(parsed)) throw unexpected(path, "is not a JSON object");
  return parsed;
}

/** SessionEnd groups, validated; null when the file has none. */
function sessionEndGroups(settings: Json, path: string): Json[] | null {
  const hooks = settings.hooks;
  if (hooks === undefined) return null;
  if (!isObject(hooks)) throw unexpected(path, "has a non-object hooks value");
  const groups = hooks.SessionEnd;
  if (groups === undefined) return null;
  if (!Array.isArray(groups) || !groups.every(isObject)) {
    throw unexpected(path, "has an unexpected hooks.SessionEnd shape");
  }
  return groups;
}

/** Drop owned hooks; groups left empty by that are dropped too. */
function withoutOwned(groups: Json[], identity: HookIdentity): Json[] {
  const kept: Json[] = [];
  for (const group of groups) {
    const hooks = Array.isArray(group.hooks) ? group.hooks : null;
    if (!hooks) {
      kept.push(group);
      continue;
    }
    const remaining = hooks.filter(
      (hook) => !(isObject(hook) && isOwnedHookCommand(hook.command, identity))
    );
    if (remaining.length === hooks.length) kept.push(group);
    else if (remaining.length > 0) kept.push({ ...group, hooks: remaining });
  }
  return kept;
}

const countOwned = (groups: Json[], identity: HookIdentity): number =>
  groups
    .flatMap((group) => (Array.isArray(group.hooks) ? group.hooks : []))
    .filter(
      (hook) => isObject(hook) && isOwnedHookCommand(hook.command, identity)
    ).length;

/** Whether the owned entry is present; null when the file cannot be read. */
export async function inspectClaudeHook(
  settingsPath: string,
  given: HookIdentity
): Promise<boolean | null> {
  const identity = await canonicalIdentity(given);
  try {
    const settings = await readSettings(settingsPath);
    if (!settings) return false;
    return (
      countOwned(sessionEndGroups(settings, settingsPath) ?? [], identity) > 0
    );
  } catch {
    return null;
  }
}

/** Install (or repair) exactly one owned SessionEnd entry. */
export async function installClaudeHook(
  settingsPath: string,
  given: HookIdentity
): Promise<{ command: string; changed: boolean }> {
  const identity = await canonicalIdentity(given);
  const settings = (await readSettings(settingsPath)) ?? {};
  const groups = sessionEndGroups(settings, settingsPath) ?? [];
  const command = buildClaudeHookCommand(identity);
  const current = groups.some(
    (group) =>
      Array.isArray(group.hooks) &&
      group.hooks.some(
        (hook) =>
          isObject(hook) &&
          hook.command === command &&
          hook.timeout === CLAUDE_HOOK_TIMEOUT_SECONDS
      )
  );
  if (current && countOwned(groups, identity) === 1) {
    return { command, changed: false };
  }
  const next = [
    ...withoutOwned(groups, identity),
    {
      hooks: [
        { type: "command", command, timeout: CLAUDE_HOOK_TIMEOUT_SECONDS },
      ],
    },
  ];
  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  settings.hooks = { ...hooks, SessionEnd: next };
  await writeMcpConfigText(
    settingsPath,
    `${JSON.stringify(settings, null, 2)}\n`
  );
  return { command, changed: true };
}

/** Remove owned entries only. A missing file or entry is not an error. */
export async function removeClaudeHook(
  settingsPath: string,
  given: HookIdentity
): Promise<{ removed: number }> {
  const identity = await canonicalIdentity(given);
  const settings = await readSettings(settingsPath);
  if (!settings) return { removed: 0 };
  const groups = sessionEndGroups(settings, settingsPath);
  if (!groups) return { removed: 0 };
  const removed = countOwned(groups, identity);
  if (removed === 0) return { removed: 0 };
  const hooks = settings.hooks as Json;
  const next = withoutOwned(groups, identity);
  if (next.length > 0) hooks.SessionEnd = next;
  else delete hooks.SessionEnd;
  await writeMcpConfigText(
    settingsPath,
    `${JSON.stringify(settings, null, 2)}\n`
  );
  return { removed };
}
