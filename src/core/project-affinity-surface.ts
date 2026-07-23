/**
 * Shared trust boundary for caller-supplied project affinity.
 *
 * Raw roots and hints stop here. Retrieval pipelines receive only the resolved,
 * redaction-safe scoring input.
 *
 * @module src/core/project-affinity-surface
 */

import type { Config, ProjectAffinityInput } from "../config/types";
import type { ProjectAffinityScoringInput } from "../pipeline/project-affinity";

import { resolveProjectAffinity } from "./project-affinity";

export const MAX_PROJECT_AFFINITY_INPUTS = 16;

export interface CliProjectAffinityRequest {
  projectAffinityDisabled?: boolean;
  projectRoots?: string[];
}

export class ProjectAffinityInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectAffinityInputError";
  }
}

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const normalizeProjectAffinityValues = (
  values: readonly string[] | undefined,
  label: "project hints" | "project roots"
): string[] => {
  if (values === undefined) return [];
  if (
    !Array.isArray(values) ||
    values.length > MAX_PROJECT_AFFINITY_INPUTS ||
    values.some((value) => typeof value !== "string")
  ) {
    throw new ProjectAffinityInputError(
      `${label} must contain at most ${MAX_PROJECT_AFFINITY_INPUTS} strings`
    );
  }
  const normalized = [
    ...new Set(values.map((value) => value.normalize("NFC").trim())),
  ].sort(compareCodeUnits);
  if (normalized.some((value) => value.length === 0)) {
    throw new ProjectAffinityInputError(
      `${label} must not contain empty values`
    );
  }
  return normalized;
};

const scoringInput = async (
  input: ProjectAffinityInput,
  config: Config,
  channel: "local" | "remote"
): Promise<ProjectAffinityScoringInput> => ({
  enabled: config.projectAffinity?.enabled,
  contribution: config.projectAffinity?.contribution,
  resolution: await resolveProjectAffinity(input, config.collections, {
    channel,
  }),
});

export const resolveCliProjectAffinity = async (
  config: Config,
  options: {
    cwd: string;
    disabled?: boolean;
    projectRoots?: readonly string[];
  }
): Promise<ProjectAffinityScoringInput | undefined> => {
  const projectRoots = normalizeProjectAffinityValues(
    options.projectRoots,
    "project roots"
  );
  if (options.disabled && projectRoots.length > 0) {
    throw new ProjectAffinityInputError(
      "--no-project-affinity cannot be combined with --project-root"
    );
  }
  if (options.disabled || config.projectAffinity?.enabled === false) return;

  const roots =
    projectRoots.length > 0
      ? projectRoots.map((path) => ({
          path,
          source: "cli_explicit" as const,
        }))
      : [{ path: options.cwd, source: "cli_cwd" as const }];
  return scoringInput({ roots }, config, "local");
};

export const resolveRemoteProjectAffinity = async (
  config: Config,
  projectHints: readonly string[] | undefined
): Promise<ProjectAffinityScoringInput | undefined> => {
  const hints = normalizeProjectAffinityValues(projectHints, "project hints");
  if (hints.length === 0 || config.projectAffinity?.enabled === false) return;
  return scoringInput(
    {
      roots: hints.map((hint) => ({
        hint,
        source: "remote_hint" as const,
      })),
    },
    config,
    "remote"
  );
};
