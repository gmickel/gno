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
import type { SetupCommandOptions } from "./setup";

import { loadConfig } from "../../config";
import { runProjectProfileCommand } from "./profile";

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

export async function inspectSetupProfile(
  options: SetupProfileIntegrationOptions
): Promise<ProjectProfileCommandResult | null> {
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
    return outcome.result;
  } catch {
    return null;
  }
}

export async function applySetupProfile(
  options: SetupProfileIntegrationOptions,
  inspection: ProjectProfileCommandResult | null
): Promise<ProjectProfileApplyCommandResult | null> {
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
    return outcome.result;
  } catch {
    return null;
  }
}

export async function setupOptionsAfterProfileApply(
  options: SetupCommandOptions,
  applied: ProjectProfileApplyCommandResult | null
): Promise<SetupCommandOptions> {
  const collectionName = applied?.receipt?.resources.find(
    (resource) => resource.kind === "collection"
  )?.id;
  if (
    !collectionName ||
    (applied.status !== "applied" && applied.status !== "unchanged")
  ) {
    return options;
  }
  const loaded = await loadConfig(options.configPath);
  const collection = loaded.ok
    ? loaded.value.collections.find((item) => item.name === collectionName)
    : undefined;
  if (!collection) return options;
  return {
    ...options,
    folder: collection.path,
    name: options.name ?? collection.name,
    exclude: options.exclude,
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
