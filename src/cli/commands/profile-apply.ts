/**
 * Mutating project-profile CLI composition.
 *
 * @module src/cli/commands/profile-apply
 */

// node:fs/promises provides recursive directory creation; Bun has no equivalent structural API.
import { mkdir } from "node:fs/promises";

import type { ProjectProfileApplyReceipt } from "../../core/project-profile-apply";
import type {
  ProjectProfileDiscoveryDependencies,
  ProjectProfileDiscoverySummary,
} from "../../core/project-profile-discovery";
import type { SqliteAdapter as SqliteAdapterType } from "../../store/sqlite/adapter";
import type { ProjectProfileCommandDiagnostic } from "./profile";

import { getIndexDbPath } from "../../app/constants";
import {
  createDefaultConfig,
  getConfigPaths,
  loadConfig,
  toAbsolutePath,
} from "../../config";
import {
  applyProjectProfile,
  validateProjectProfileRuntimePaths,
} from "../../core/project-profile-apply";
import { discoverProjectProfile } from "../../core/project-profile-discovery";
import {
  ProjectProfileFileError,
  readProjectProfileFile,
} from "../../core/project-profile-file";
import { SqliteAdapter } from "../../store/sqlite/adapter";
import {
  compilerDiagnostic,
  discoveryDiagnostic,
  PROJECT_PROFILE_COMMAND_SCHEMA_VERSION,
  sortDiagnostics,
} from "./profile";

export interface ProjectProfileApplyCommandResult {
  schemaVersion: typeof PROJECT_PROFILE_COMMAND_SCHEMA_VERSION;
  command: "apply";
  status:
    | "applied"
    | "unchanged"
    | "invalid"
    | "not_found"
    | "disabled"
    | "failed";
  applied: boolean;
  discovery: ProjectProfileDiscoverySummary;
  receipt: ProjectProfileApplyReceipt | null;
  diagnostics: ProjectProfileCommandDiagnostic[];
}

export interface ProjectProfileApplyCommandOutcome {
  result: ProjectProfileApplyCommandResult;
  exitCode: 0 | 1 | 2;
}

export interface ProjectProfileApplyCommandOptions {
  path?: string;
  cwd?: string;
  channel?: "local" | "remote";
  configPath?: string;
  dataDir?: string;
  indexName?: string;
  discoveryDependencies?: Partial<ProjectProfileDiscoveryDependencies>;
  readProfileFn?: (path: string) => Promise<string>;
  createStore?: () => SqliteAdapterType;
}

const failedApplyResult = (
  status: "disabled" | "failed" | "invalid" | "not_found",
  discovery: ProjectProfileDiscoverySummary,
  diagnostics: ProjectProfileCommandDiagnostic[]
): ProjectProfileApplyCommandResult => ({
  schemaVersion: PROJECT_PROFILE_COMMAND_SCHEMA_VERSION,
  command: "apply",
  status,
  applied: false,
  discovery,
  receipt: null,
  diagnostics: sortDiagnostics(diagnostics),
});

/**
 * Apply one trusted local profile through the same discovery/compiler/diff
 * pipeline used by the read commands.
 */
export async function runProjectProfileApplyCommand(
  options: ProjectProfileApplyCommandOptions
): Promise<ProjectProfileApplyCommandOutcome> {
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
      result: failedApplyResult(
        status,
        discovery.summary,
        discoveryDiagnostics
      ),
      exitCode: discoveryDiagnostics.some(
        (diagnostic) => diagnostic.code === "PROFILE_DISCOVERY_FAILED"
      )
        ? 2
        : 1,
    };
  }
  if (!(discovery.profilePath && discovery.profileRoot)) {
    return {
      result: failedApplyResult("failed", discovery.summary, [
        ...discoveryDiagnostics,
        {
          code: "PROFILE_DISCOVERY_FAILED",
          severity: "error",
          path: ".gno/index.yml",
          message: "Discovery returned no trusted local profile identity.",
          remediation: "Rerun with an exact readable project root.",
        },
      ]),
      exitCode: 2,
    };
  }

  let profileYaml: string;
  try {
    profileYaml = await (options.readProfileFn ?? readProjectProfileFile)(
      discovery.profilePath
    );
  } catch (error) {
    const invalidFile = error instanceof ProjectProfileFileError ? error : null;
    return {
      result: failedApplyResult("failed", discovery.summary, [
        ...discoveryDiagnostics,
        {
          code: invalidFile?.code ?? "PROFILE_READ_FAILED",
          severity: "error",
          path: ".gno/index.yml",
          message:
            invalidFile?.message ??
            "The selected project profile could not be read.",
          remediation: invalidFile
            ? "Reduce or repair .gno/index.yml and retry."
            : "Repair local file permissions and retry.",
        },
      ]),
      exitCode: invalidFile ? 1 : 2,
    };
  }

  const paths = getConfigPaths();
  const configPath = toAbsolutePath(options.configPath ?? paths.configFile);
  const dataDir = toAbsolutePath(options.dataDir ?? paths.dataDir);
  const indexName = options.indexName ?? "default";
  const indexPath = getIndexDbPath(indexName, {
    config: paths.configDir,
    data: dataDir,
    cache: paths.cacheDir,
  });
  const overlap = await validateProjectProfileRuntimePaths(
    discovery.profileRoot,
    [
      { label: "Config", path: configPath },
      { label: "User data directory", path: dataDir },
      { label: "Model cache directory", path: paths.cacheDir },
      { label: "Index database", path: indexPath },
    ]
  );
  if (overlap) {
    return {
      result: failedApplyResult("invalid", discovery.summary, [
        ...discoveryDiagnostics,
        {
          code: overlap.code,
          severity: "error",
          path: "runtime",
          message: overlap.message,
          remediation: overlap.remediation,
        },
      ]),
      exitCode: 1,
    };
  }
  const loaded = await loadConfig(configPath);
  if (!loaded.ok && loaded.error.code !== "NOT_FOUND") {
    return {
      result: failedApplyResult("invalid", discovery.summary, [
        ...discoveryDiagnostics,
        {
          code: "CONFIG_INVALID",
          severity: "error",
          path: "config",
          message: "The selected local GNO config could not be loaded safely.",
          remediation: "Repair the local config and rerun gno profile apply.",
        },
      ]),
      exitCode: 1,
    };
  }
  const startingConfig = loaded.ok ? loaded.value : createDefaultConfig();
  const store = options.createStore?.() ?? new SqliteAdapter();
  try {
    await mkdir(dataDir, { recursive: true });
    store.setConfigPath(configPath);
    const opened = await store.open(indexPath, startingConfig.ftsTokenizer);
    if (!opened.ok) {
      return {
        result: failedApplyResult("failed", discovery.summary, [
          ...discoveryDiagnostics,
          {
            code: "INDEX_OPEN_FAILED",
            severity: "error",
            path: "index",
            message: "The selected local index could not be opened.",
            remediation: "Repair the user data directory and rerun apply.",
          },
        ]),
        exitCode: 2,
      };
    }
    const applied = await applyProjectProfile({
      profileYaml,
      profileRoot: discovery.profileRoot,
      profilePath: discovery.profilePath,
      configPath,
      dataDir,
      store,
      runtimePaths: [
        { label: "Model cache directory", path: paths.cacheDir },
        { label: "Index database", path: indexPath },
      ],
    });
    if (!applied.ok) {
      const diagnostics = [
        ...discoveryDiagnostics,
        ...(applied.error.diagnostics ?? []).map(compilerDiagnostic),
        {
          code: applied.error.code,
          severity: "error" as const,
          path:
            applied.error.code === "PROFILE_INVALID"
              ? ".gno/index.yml"
              : "runtime",
          message: applied.error.message,
          remediation: applied.error.remediation,
        },
      ];
      const validationFailure =
        applied.error.code === "PROFILE_INVALID" ||
        applied.error.code === "RUNTIME_PATH_OVERLAP";
      return {
        result: failedApplyResult(
          validationFailure ? "invalid" : "failed",
          discovery.summary,
          diagnostics
        ),
        exitCode: validationFailure ? 1 : 2,
      };
    }
    return {
      result: {
        schemaVersion: PROJECT_PROFILE_COMMAND_SCHEMA_VERSION,
        command: "apply",
        status: applied.receipt.status,
        applied: applied.receipt.status === "applied",
        discovery: discovery.summary,
        receipt: applied.receipt,
        diagnostics: sortDiagnostics([
          ...discoveryDiagnostics,
          ...applied.receipt.diagnostics,
        ]),
      },
      exitCode: 0,
    };
  } catch {
    return {
      result: failedApplyResult("failed", discovery.summary, [
        ...discoveryDiagnostics,
        {
          code: "RUNTIME_IO_FAILED",
          severity: "error",
          path: "runtime",
          message: "The selected runtime directories could not be prepared.",
          remediation:
            "Repair user config/data-directory permissions and rerun apply.",
        },
      ]),
      exitCode: 2,
    };
  } finally {
    await store.close();
  }
}

export function formatProjectProfileApplyResult(
  result: ProjectProfileApplyCommandResult,
  options: { json: boolean }
): string {
  if (options.json) return JSON.stringify(result, null, 2);
  const lines = [
    `Profile apply ${result.status}: ${result.discovery.profile ?? "(not found)"}`,
  ];
  if (result.receipt) {
    lines.push(`Fingerprint: ${result.receipt.profile.fingerprint}`);
    lines.push(`Diff: ${result.receipt.diff.status}`);
    for (const resource of result.receipt.resources) {
      lines.push(
        `  ${resource.disposition} ${resource.kind} ${resource.id}${resource.pendingIndexing ? " (indexing pending)" : ""}`
      );
    }
  }
  for (const issue of result.diagnostics) {
    lines.push(
      `${issue.severity === "error" ? "Error" : "Warning"} ${issue.code}: ${issue.message} ${issue.remediation}`
    );
  }
  return lines.join("\n");
}
