/**
 * Read-only project profile CLI composition.
 *
 * All outputs are deterministic and redact machine-local paths. This module
 * never saves config, opens an index, or downloads a model.
 *
 * @module src/cli/commands/profile
 */

// node:fs/promises provides realpath; Bun has no equivalent for canonical
// collection-path comparison.
import { realpath } from "node:fs/promises";

import type { Config } from "../../config/types";
import type {
  ProjectProfileDesiredState,
  ProjectProfileDiagnostic,
} from "../../core/project-profile";
import type { ProjectProfileDiff } from "../../core/project-profile-diff";
import type {
  ProjectProfileDiscoveryDependencies,
  ProjectProfileDiscoverySummary,
} from "../../core/project-profile-discovery";

import { getModelsCachePath } from "../../app/constants";
import { createDefaultConfig, loadConfig, type LoadResult } from "../../config";
import { compileProjectProfileYaml } from "../../core/project-profile";
import { buildProjectProfileDiff } from "../../core/project-profile-diff";
import {
  discoverProjectProfile,
  type ProjectProfileDiscoveryDiagnostic,
} from "../../core/project-profile-discovery";
import { ModelCache } from "../../llm/cache";

export const PROJECT_PROFILE_COMMAND_SCHEMA_VERSION = "1.0" as const;

export type ProjectProfileCommandName = "check" | "show" | "diff";

export interface ProjectProfileCommandDiagnostic {
  code: string;
  severity: "error" | "warning";
  path: string;
  message: string;
  remediation: string;
}

export interface ProjectProfileCommandResult {
  schemaVersion: typeof PROJECT_PROFILE_COMMAND_SCHEMA_VERSION;
  command: ProjectProfileCommandName;
  status: "valid" | "invalid" | "not_found" | "disabled";
  valid: boolean;
  discovery: ProjectProfileDiscoverySummary;
  profile: {
    fingerprint: string;
    desiredState: ProjectProfileDesiredState | null;
  } | null;
  diff: ProjectProfileDiff | null;
  diagnostics: ProjectProfileCommandDiagnostic[];
}

export interface ProjectProfileCommandOutcome {
  result: ProjectProfileCommandResult;
  exitCode: 0 | 1 | 2;
}

export interface ProjectProfileCommandOptions {
  command: ProjectProfileCommandName;
  path?: string;
  cwd?: string;
  channel?: "local" | "remote";
  configPath?: string;
  offline?: boolean;
  discoveryDependencies?: Partial<ProjectProfileDiscoveryDependencies>;
  loadConfigFn?: (path?: string) => Promise<LoadResult<Config>>;
  readProfileFn?: (path: string) => Promise<string>;
  canonicalizePath?: (path: string) => Promise<string>;
  isModelAvailableOffline?: (
    modelUri: string,
    modelType: "embed" | "rerank" | "expand" | "gen"
  ) => Promise<boolean>;
}

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const remediationForCompilerDiagnostic = (
  diagnostic: ProjectProfileDiagnostic
): string => {
  switch (diagnostic.code) {
    case "MODEL_PRESET_NOT_FOUND":
      return "Configure the named local preset alias or select a configured alias.";
    case "MODEL_PRESET_UNAVAILABLE_OFFLINE":
      return "Cache every model in the named preset before retrying with --offline.";
    case "MODEL_CACHE_CHECK_FAILED":
      return "Repair local model-cache metadata and retry; no download was attempted.";
    case "MIGRATION_REQUIRED":
    case "UNSUPPORTED_SCHEMA_MAJOR":
    case "UNSUPPORTED_SCHEMA_MINOR":
      return "Migrate .gno/index.yml to the supported schemaVersion.";
    case "PATH_NOT_FOUND":
      return "Create the referenced repository-relative path or update the profile.";
    case "SYMLINK_ESCAPE":
      return "Replace the escaping symlink with a path contained by the profile root.";
    case "CONTEXT_FILE_INVALID":
    case "CONTEXT_FILE_UNREADABLE":
      return "Replace the context file with readable UTF-8 text.";
    case "UNSAFE_PATH":
      return "Use a repository-relative path without traversal, expansion, or runtime state.";
    default:
      return "Repair the reported profile field and rerun gno profile check.";
  }
};

export const compilerDiagnostic = (
  issue: ProjectProfileDiagnostic
): ProjectProfileCommandDiagnostic => ({
  ...issue,
  remediation: remediationForCompilerDiagnostic(issue),
});

export const discoveryDiagnostic = (
  issue: ProjectProfileDiscoveryDiagnostic
): ProjectProfileCommandDiagnostic => ({ ...issue });

export const sortDiagnostics = (
  diagnostics: ProjectProfileCommandDiagnostic[]
): ProjectProfileCommandDiagnostic[] =>
  diagnostics.sort(
    (left, right) =>
      compareCodeUnits(left.path, right.path) ||
      compareCodeUnits(left.code, right.code) ||
      compareCodeUnits(left.message, right.message)
  );

const resultWithoutProfile = (
  command: ProjectProfileCommandName,
  status: "invalid" | "not_found" | "disabled",
  discovery: ProjectProfileDiscoverySummary,
  diagnostics: ProjectProfileCommandDiagnostic[]
): ProjectProfileCommandResult => ({
  schemaVersion: PROJECT_PROFILE_COMMAND_SCHEMA_VERSION,
  command,
  status,
  valid: false,
  discovery,
  profile: null,
  diff: null,
  diagnostics: sortDiagnostics(diagnostics),
});

const loadProfileConfig = async (
  options: ProjectProfileCommandOptions
): Promise<
  | {
      ok: true;
      config: Config;
      diagnostics: ProjectProfileCommandDiagnostic[];
    }
  | { ok: false; diagnostic: ProjectProfileCommandDiagnostic }
> => {
  const loaded = await (options.loadConfigFn ?? loadConfig)(options.configPath);
  if (!loaded.ok) {
    if (loaded.error.code === "NOT_FOUND") {
      return {
        ok: true,
        config: createDefaultConfig(),
        diagnostics: [
          {
            code: "CONFIG_NOT_FOUND",
            severity: "warning",
            path: "config",
            message:
              "No local GNO config exists; diff uses an empty current state.",
            remediation:
              "Run gno profile diff, then apply the profile in a later explicit step.",
          },
        ],
      };
    }
    return {
      ok: false,
      diagnostic: {
        code: "CONFIG_INVALID",
        severity: "error",
        path: "config",
        message: "The selected local GNO config could not be loaded safely.",
        remediation: "Repair the local config and rerun gno profile check.",
      },
    };
  }
  return {
    ok: true,
    config: loaded.value,
    diagnostics: loaded.warnings.map((warning) => ({
      code: "CONFIG_WARNING",
      severity: "warning",
      path: warning.path,
      message: warning.message,
      remediation: "Repair the warned local config entry before applying.",
    })),
  };
};

const defaultReadProfile = (path: string): Promise<string> =>
  Bun.file(path).text();

/**
 * Execute one read-only profile command and return a classified exit code.
 */
export async function runProjectProfileCommand(
  options: ProjectProfileCommandOptions
): Promise<ProjectProfileCommandOutcome> {
  const discovery = await discoverProjectProfile(
    {
      channel: options.channel ?? "local",
      cwd: options.cwd,
      rootOverride: options.path,
    },
    options.discoveryDependencies
  );
  const discoveryDiagnostics = discovery.diagnostics.map(discoveryDiagnostic);
  if (discovery.summary.status !== "found") {
    const status =
      discovery.summary.status === "not_found"
        ? "not_found"
        : discovery.summary.status === "disabled"
          ? "disabled"
          : "invalid";
    return {
      result: resultWithoutProfile(
        options.command,
        status,
        discovery.summary,
        discoveryDiagnostics
      ),
      exitCode: 1,
    };
  }
  if (!(discovery.profilePath && discovery.profileRoot)) {
    return {
      result: resultWithoutProfile(
        options.command,
        "invalid",
        discovery.summary,
        [
          ...discoveryDiagnostics,
          {
            code: "PROFILE_DISCOVERY_FAILED",
            severity: "error",
            path: ".gno/index.yml",
            message: "Discovery returned no trusted local profile identity.",
            remediation: "Rerun with an exact readable project root.",
          },
        ]
      ),
      exitCode: 2,
    };
  }

  const configResult = await loadProfileConfig(options);
  if (!configResult.ok) {
    return {
      result: resultWithoutProfile(
        options.command,
        "invalid",
        discovery.summary,
        [...discoveryDiagnostics, configResult.diagnostic]
      ),
      exitCode: 1,
    };
  }

  let yaml: string;
  try {
    yaml = await (options.readProfileFn ?? defaultReadProfile)(
      discovery.profilePath
    );
  } catch {
    return {
      result: resultWithoutProfile(
        options.command,
        "invalid",
        discovery.summary,
        [
          ...discoveryDiagnostics,
          {
            code: "PROFILE_READ_FAILED",
            severity: "error",
            path: ".gno/index.yml",
            message: "The selected project profile could not be read.",
            remediation: "Repair local file permissions and retry.",
          },
        ]
      ),
      exitCode: 2,
    };
  }

  const modelCache = options.offline
    ? new ModelCache(getModelsCachePath())
    : null;
  const offlineAvailability =
    options.isModelAvailableOffline ??
    (modelCache ? modelCache.isCached.bind(modelCache) : undefined);
  const compiled = await compileProjectProfileYaml(yaml, {
    profileRoot: discovery.profileRoot,
    config: configResult.config,
    ...(offlineAvailability
      ? { isModelAvailableOffline: offlineAvailability }
      : {}),
  });
  if (!compiled.ok) {
    return {
      result: resultWithoutProfile(
        options.command,
        "invalid",
        discovery.summary,
        [
          ...discoveryDiagnostics,
          ...configResult.diagnostics,
          ...compiled.diagnostics.map(compilerDiagnostic),
        ]
      ),
      exitCode: 1,
    };
  }

  let diff: ProjectProfileDiff | null = null;
  const diagnostics = [
    ...discoveryDiagnostics,
    ...configResult.diagnostics,
    ...compiled.value.diagnostics.map(compilerDiagnostic),
  ];
  if (options.command === "diff") {
    const built = await buildProjectProfileDiff({
      desiredState: compiled.value.desiredState,
      expectedCollectionRoot: compiled.value.resolvedPaths.collectionRoot,
      config: configResult.config,
      canonicalizePath: options.canonicalizePath ?? realpath,
    });
    diff = built.diff;
    diagnostics.push(...built.diagnostics);
  }

  return {
    result: {
      schemaVersion: PROJECT_PROFILE_COMMAND_SCHEMA_VERSION,
      command: options.command,
      status: "valid",
      valid: true,
      discovery: discovery.summary,
      profile: {
        fingerprint: compiled.value.fingerprint,
        desiredState:
          options.command === "check" ? null : compiled.value.desiredState,
      },
      diff,
      diagnostics: sortDiagnostics(diagnostics),
    },
    exitCode: 0,
  };
}

export function formatProjectProfileResult(
  result: ProjectProfileCommandResult,
  options: { json: boolean }
): string {
  if (options.json) {
    return JSON.stringify(result, null, 2);
  }
  const lines = [
    `Profile ${result.status}: ${result.discovery.profile ?? "(not found)"}`,
  ];
  if (result.profile) {
    lines.push(`Fingerprint: ${result.profile.fingerprint}`);
  }
  if (result.command === "show" && result.profile?.desiredState) {
    lines.push(Bun.YAML.stringify(result.profile.desiredState).trimEnd());
  }
  if (result.diff) {
    lines.push(`Diff: ${result.diff.status}`);
    for (const change of result.diff.changes) {
      lines.push(`  ${change.action} ${change.field}: ${change.summary}`);
    }
  }
  for (const issue of result.diagnostics) {
    lines.push(
      `${issue.severity === "error" ? "Error" : "Warning"} ${issue.code}: ${issue.message} ${issue.remediation}`
    );
  }
  return lines.join("\n");
}
