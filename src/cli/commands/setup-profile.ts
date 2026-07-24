/**
 * Optional project-profile composition for `gno setup`.
 *
 * Inspection is always read-only and non-fatal. Application requires the
 * explicit `--apply-profile` request and reuses the lock-safe profile command.
 *
 * @module src/cli/commands/setup-profile
 */

import type {
  ProjectProfileCommandOutcome,
  ProjectProfileCommandResult,
} from "./profile";
import type {
  ProjectProfileApplyCommandOutcome,
  ProjectProfileApplyCommandResult,
} from "./profile-apply";
import type { SetupCommandOptions, SetupCommandOutcome } from "./setup";

import { loadConfig } from "../../config";
import { runProjectProfileCommand } from "./profile";
import { SETUP_COMMAND_SCHEMA_VERSION } from "./setup";

export interface SetupProfileAdvisoryInput {
  folder: string;
  configPath?: string;
  offline?: boolean;
}

export interface SetupProfileIntegrationOptions extends SetupCommandOptions {
  applyProfile?: boolean;
  inspectProfileAdvisory?: (
    input: SetupProfileAdvisoryInput
  ) => Promise<ProjectProfileCommandOutcome>;
  applyProfileAdvisory?: (
    input: SetupProfileAdvisoryInput
  ) => Promise<ProjectProfileApplyCommandOutcome>;
  onProfileAdvisory?: (result: ProjectProfileCommandResult) => void;
  onProfileApply?: (result: ProjectProfileApplyCommandResult) => void;
}

export interface SetupProfileInspectionOutcome {
  result: ProjectProfileCommandResult | null;
  failed: boolean;
}

export function profileInspectionFailureOutcome(): SetupCommandOutcome {
  return {
    result: {
      schemaVersion: SETUP_COMMAND_SCHEMA_VERSION,
      status: "failed",
      lexical: {
        receipt: null,
        error: {
          code: "profile_inspection_failed",
          message:
            "The requested project profile could not be inspected safely before setup.",
          remediation:
            "Run `gno profile check` for diagnostics, repair the reported problem, and retry setup.",
        },
      },
      semantic: null,
    },
    exitCode: 2,
  };
}

export function profileApplyFailureOutcome(
  outcome: ProjectProfileApplyCommandOutcome | null
): SetupCommandOutcome {
  return {
    result: {
      schemaVersion: SETUP_COMMAND_SCHEMA_VERSION,
      status: "failed",
      lexical: {
        receipt: null,
        error: {
          code: "profile_apply_failed",
          message:
            "The valid project profile could not be applied safely before setup.",
          remediation:
            "Run `gno profile apply` for diagnostics, repair the reported problem, and retry setup.",
        },
      },
      semantic: null,
    },
    exitCode: outcome?.exitCode === 1 ? 1 : 2,
  };
}

export function profileApplySucceeded(
  outcome: ProjectProfileApplyCommandOutcome | null
): boolean {
  if (
    outcome?.exitCode !== 0 ||
    (outcome.result.status !== "applied" &&
      outcome.result.status !== "unchanged")
  ) {
    return false;
  }
  const receipt = outcome.result.receipt;
  if (
    !receipt ||
    receipt.status !== outcome.result.status ||
    outcome.result.applied !== (outcome.result.status === "applied")
  ) {
    return false;
  }
  const collectionResources = receipt.resources.filter(
    (resource) => resource.kind === "collection"
  );
  return (
    collectionResources.length === 1 &&
    Boolean(collectionResources[0]?.id.trim())
  );
}

export async function inspectSetupProfile(
  options: SetupProfileIntegrationOptions
): Promise<SetupProfileInspectionOutcome> {
  try {
    const outcome = await (
      options.inspectProfileAdvisory ??
      ((input: SetupProfileAdvisoryInput) =>
        runProjectProfileCommand({
          command: "check",
          cwd: input.folder,
          configPath: input.configPath,
          offline: input.offline,
        }))
    )({
      folder: options.folder,
      configPath: options.configPath,
      offline: options.offline,
    });
    options.onProfileAdvisory?.(outcome.result);
    return { result: outcome.result, failed: false };
  } catch {
    return { result: null, failed: true };
  }
}

export async function applySetupProfile(
  options: SetupProfileIntegrationOptions,
  inspection: ProjectProfileCommandResult | null
): Promise<ProjectProfileApplyCommandOutcome | null> {
  if (!options.applyProfile || inspection?.status !== "valid") return null;
  try {
    const outcome = await (
      options.applyProfileAdvisory ??
      ((input: SetupProfileAdvisoryInput) =>
        import("./profile-apply").then(({ runProjectProfileApplyCommand }) =>
          runProjectProfileApplyCommand({
            cwd: input.folder,
            configPath: input.configPath,
            indexName: options.indexName,
          })
        ))
    )({
      folder: options.folder,
      configPath: options.configPath,
      offline: options.offline,
    });
    options.onProfileApply?.(outcome.result);
    return outcome;
  } catch {
    return null;
  }
}

export async function setupOptionsAfterProfileApply(
  options: SetupCommandOptions,
  applied: ProjectProfileApplyCommandResult | null
): Promise<SetupCommandOptions | null> {
  if (
    !applied ||
    (applied.status !== "applied" && applied.status !== "unchanged")
  ) {
    return options;
  }
  const collectionName = applied?.receipt?.resources.find(
    (resource) => resource.kind === "collection"
  )?.id;
  if (!collectionName) return null;
  const loaded = await loadConfig(options.configPath);
  const collection = loaded.ok
    ? loaded.value.collections.find((item) => item.name === collectionName)
    : undefined;
  if (!collection) return null;
  return {
    ...options,
    folder: collection.path,
    name: options.name ?? collection.name,
    exclude: options.exclude,
    additiveStoreProjection: true,
  };
}

export function formatSetupProfileAdvisory(
  result: ProjectProfileCommandResult,
  options: { applyRequested?: boolean } = {}
): string {
  if (result.status === "not_found" || result.status === "disabled") return "";
  if (result.status === "valid" && result.profile) {
    return [
      `setup: project profile valid (${result.discovery.profile}; fingerprint=${result.profile.fingerprint})`,
      "setup: preview profile changes with `gno profile diff`",
      options.applyRequested
        ? "setup: applying the profile before lexical setup"
        : "setup: rerun with `--apply-profile` to apply it before lexical setup",
    ].join("\n");
  }
  const firstError = result.diagnostics.find(
    (diagnostic) => diagnostic.severity === "error"
  );
  return [
    `setup: project profile ${result.status}; continuing without applying it`,
    firstError
      ? `setup: ${firstError.code}: ${firstError.message}`
      : "setup: run `gno profile check` for repair guidance",
  ].join("\n");
}
