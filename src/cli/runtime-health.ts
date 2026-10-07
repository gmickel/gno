/**
 * Which Bun the GNO processes on this machine run on (fn-213).
 *
 * Two read-only checks for `gno doctor` and `gno status`:
 * - client registrations whose interpreter or entrypoint is missing, below
 *   the supported Bun, or a different Bun than the one running the check;
 * - running residents (`serve`, `daemon`) on a Bun below the floor or older
 *   than the one running the check, including residents started by another
 *   GNO version, whose runtime is read from their `/api/status`.
 *
 * Nothing here starts a registered command or signals a process; an
 * interpreter is only asked for `--version`, under a short timeout.
 *
 * @module src/cli/runtime-health
 */

// node:fs realpathSync: synchronous link resolution; Bun has no realpath API.
import { realpathSync } from "node:fs";
// node:path basename: no Bun path utilities.
import { basename } from "node:path";

import type { McpScope, McpTarget } from "./commands/mcp/paths";

import { BUN_FLOOR, bunMeetsFloor } from "../app/bun-runtime";
import { VERSION } from "../app/constants";
import { getServersKey } from "./commands/mcp/config";
import { resolveMcpConfigLocation } from "./commands/mcp/config-discovery";
import {
  getJsoncServerEntry,
  getTomlServerEntry,
  getYamlServerEntry,
} from "./commands/mcp/config-editors";
import { getTargetDisplayName, resolveAllMcpPaths } from "./commands/mcp/paths";
import { readExistingRegistration } from "./commands/mcp/repair-entry";
import {
  type DetachKind,
  isProcessAlive,
  readPidFile,
  resolveProcessPaths,
} from "./detach";

export type RuntimeIssueSeverity = "error" | "warn" | "info";

export interface RuntimeIssue {
  kind: "registration" | "resident";
  severity: RuntimeIssueSeverity;
  /** What it is about: a client registration or a resident process. */
  subject: string;
  message: string;
  /** Command or steps that repair it. */
  repair: string;
}

/** How long an interpreter may take to answer `--version`. */
const VERSION_PROBE_TIMEOUT_MS = 2000;
/** How long a resident may take to answer `/api/status`. */
const RESIDENT_PROBE_TIMEOUT_MS = 2000;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
/** A Bun version in a version manager's install path. */
const VERSION_IN_PATH =
  /[\\/](?:installs|tools|Cellar)[\\/]bun[\\/](\d+\.\d+\.\d+[^\\/]*)[\\/]/;

const realpathOrNull = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

/** The Bun version of an interpreter: from its install path, else `--version`. */
async function interpreterVersion(path: string): Promise<string | null> {
  const resolved = realpathOrNull(path) ?? path;
  const fromPath = VERSION_IN_PATH.exec(resolved)?.[1];
  if (fromPath) {
    return fromPath;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const probe = Bun.spawn([path, "--version"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    // Bound the read, not only the process: a child of the probe can hold
    // stdout open after the probe itself is killed.
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), VERSION_PROBE_TIMEOUT_MS);
    });
    const output = await Promise.race([
      new Response(probe.stdout).text(),
      timedOut,
    ]);
    if (output === null) {
      probe.kill(9);
      return null;
    }
    const version = output.trim();
    return SEMVER.test(version) ? version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const isGnoExecutable = (command: string): boolean =>
  ["gno", "gno.exe", "gno.cmd"].includes(basename(command).toLowerCase());

async function readRegistrationEntry(
  configPath: string,
  format: string
): Promise<unknown> {
  const file = Bun.file(configPath);
  if (!(await file.exists())) {
    return undefined;
  }
  const content = await file.text();
  if (!content.trim()) {
    return undefined;
  }
  const parsed =
    format === "codex_toml"
      ? getTomlServerEntry(content, configPath)
      : format === "yaml_standard"
        ? getYamlServerEntry(
            content,
            configPath,
            getServersKey("yaml_standard")
          )
        : getJsoncServerEntry(
            content,
            configPath,
            getServersKey(format as Parameters<typeof getServersKey>[0])
          );
  return parsed.exists ? parsed.entry : undefined;
}

const repairCommand = (target: McpTarget, scope: McpScope): string =>
  `gno mcp install --target ${target} --scope ${scope} --force`;

/**
 * Registrations whose launch is broken or on another Bun. Unreadable or
 * malformed configs are left to `gno mcp status`.
 */
export async function checkRegistrationRuntimes(
  overrides: { cwd?: string; homeDir?: string } = {}
): Promise<RuntimeIssue[]> {
  const issues: RuntimeIssue[] = [];
  const runningBun = realpathOrNull(process.execPath);
  const versions = new Map<string, Promise<string | null>>();
  for (const { target, scope, paths } of resolveAllMcpPaths(
    "all",
    "all",
    overrides
  )) {
    let entry: unknown;
    let configPath = paths.configPath;
    try {
      configPath = await resolveMcpConfigLocation(paths);
      entry = await readRegistrationEntry(configPath, paths.configFormat);
    } catch {
      continue;
    }
    const registration =
      entry === undefined
        ? null
        : readExistingRegistration(entry, paths.configFormat);
    if (!registration || registration.extra.enabled === false) {
      continue;
    }
    const { command, args } = registration;
    const viaBun = args[0] === "run" && args.length >= 2;
    if (!viaBun && !isGnoExecutable(command)) {
      continue;
    }
    const subject = `${getTargetDisplayName(target)} (${scope}) ${configPath}`;
    const repair = repairCommand(target, scope);
    const launchFiles = viaBun ? [command, args[1] ?? ""] : [command];
    const missing = launchFiles.filter((path) => !realpathOrNull(path));
    if (missing.length > 0) {
      issues.push({
        kind: "registration",
        severity: "error",
        subject,
        message: `launches ${missing.join(" and ")}, which no longer exists`,
        repair,
      });
      continue;
    }
    if (!viaBun) {
      // The gno launcher finds Bun on PATH when it starts.
      continue;
    }
    const resolved = realpathOrNull(command) ?? command;
    if (!versions.has(resolved)) {
      versions.set(resolved, interpreterVersion(command));
    }
    const version = await versions.get(resolved);
    if (version && !bunMeetsFloor(version)) {
      issues.push({
        kind: "registration",
        severity: "error",
        subject,
        message: `runs Bun ${version} (${command}), older than the supported minimum ${BUN_FLOOR}`,
        repair,
      });
    } else if (resolved !== runningBun) {
      issues.push({
        kind: "registration",
        severity: "info",
        subject,
        message: `runs ${version ? `Bun ${version}` : "a Bun of unknown version"} (${command}), not this Bun ${Bun.version}`,
        repair,
      });
    }
  }
  return issues;
}

/** The Bun a resident reports through `/api/status`, if it is GNO. */
async function residentBunVersion(port: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`, {
      signal: AbortSignal.timeout(RESIDENT_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as {
      indexName?: unknown;
      bootstrap?: { runtime?: { kind?: unknown; currentVersion?: unknown } };
    };
    const runtime = body?.bootstrap?.runtime;
    // Only a GNO status payload counts; anything else on the port is ignored.
    if (
      typeof body?.indexName !== "string" ||
      runtime?.kind !== "bun" ||
      typeof runtime.currentVersion !== "string" ||
      !SEMVER.test(runtime.currentVersion)
    ) {
      return null;
    }
    return runtime.currentVersion;
  } catch {
    return null;
  }
}

function restartSteps(
  kind: DetachKind,
  pid: number,
  sameVersion: boolean
): string {
  if (sameVersion) {
    return `restart it: gno ${kind} --stop, then start it again (for example gno ${kind} --detach)`;
  }
  const stop =
    process.platform === "win32" ? `taskkill /PID ${pid}` : `kill ${pid}`;
  return `it was started by another GNO version, so gno ${kind} --stop leaves it alone; stop it with ${stop}, then start it again (for example gno ${kind} --detach)`;
}

/**
 * Running residents on an unsupported or older Bun. A resident started by
 * another GNO version is read through its HTTP status; it is never signalled.
 */
export async function checkResidentRuntimes(): Promise<RuntimeIssue[]> {
  const issues: RuntimeIssue[] = [];
  for (const kind of ["serve", "daemon"] as const) {
    const { pidFile } = resolveProcessPaths(kind);
    let payload: Awaited<ReturnType<typeof readPidFile>>;
    try {
      payload = await readPidFile(pidFile);
    } catch {
      continue;
    }
    if (!payload || payload.cmd !== kind || !isProcessAlive(payload.pid)) {
      continue;
    }
    const sameVersion = payload.version === VERSION;
    let version = payload.bun_version ?? null;
    if (!version && typeof payload.port === "number") {
      version = await residentBunVersion(payload.port);
    }
    const subject = `gno ${kind} (pid ${payload.pid}, GNO ${payload.version})`;
    const repair = restartSteps(kind, payload.pid, sameVersion);
    if (!version) {
      if (!sameVersion) {
        issues.push({
          kind: "resident",
          severity: "info",
          subject,
          message:
            "is running from another GNO version; its Bun version is unknown",
          repair,
        });
      }
      continue;
    }
    if (!bunMeetsFloor(version)) {
      issues.push({
        kind: "resident",
        severity: "error",
        subject,
        message: `runs Bun ${version}, older than the supported minimum ${BUN_FLOOR}`,
        repair,
      });
    } else if (Bun.semver.order(version, Bun.version) < 0) {
      issues.push({
        kind: "resident",
        severity: "warn",
        subject,
        message: `runs Bun ${version}, older than this Bun ${Bun.version}`,
        repair,
      });
    }
  }
  return issues;
}

/** One line per issue for terminal output. */
export function formatRuntimeIssue(issue: RuntimeIssue): string {
  return `${issue.subject}: ${issue.message}. Repair: ${issue.repair}`;
}
