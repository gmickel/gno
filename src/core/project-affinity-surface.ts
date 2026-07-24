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

import { PROJECT_AFFINITY_MAX_CONTRIBUTION } from "../config/types";
import { resolveProjectAffinity } from "./project-affinity";
import { compileProjectProfileYaml } from "./project-profile";
import { discoverProjectProfile } from "./project-profile-discovery";

export const MAX_PROJECT_AFFINITY_INPUTS = 16;

export interface CliProjectAffinityRequest {
  projectAffinityDisabled?: boolean;
  projectRoots?: string[];
}

export interface ProjectProfileAffinityDefaults {
  contribution: number;
  enabled: boolean;
  profileRoot: string;
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

/**
 * Resolve only the nearest trusted local profile's compiled affinity defaults.
 * Invalid/missing profiles are a fallback signal, not a retrieval failure.
 * Profile content never supplies identity: discovery's canonical profile root
 * is the sole project root.
 */
export const resolveProjectProfileAffinityDefaults = async (
  cwd: string,
  config: Config
): Promise<ProjectProfileAffinityDefaults | null> => {
  const discovery = await discoverProjectProfile({
    channel: "local",
    cwd,
  });
  if (
    discovery.summary.status !== "found" ||
    !discovery.profilePath ||
    !discovery.profileRoot
  ) {
    return null;
  }

  try {
    const profileYaml = await Bun.file(discovery.profilePath).text();
    const compiled = await compileProjectProfileYaml(profileYaml, {
      profileRoot: discovery.profileRoot,
      config,
    });
    if (!compiled.ok) return null;
    return {
      ...compiled.value.desiredState.affinityDefaults,
      profileRoot: discovery.profileRoot,
    };
  } catch {
    return null;
  }
};

export const resolveCliProjectAffinity = async (
  config: Config,
  options: {
    cwd: string;
    disabled?: boolean;
    projectRoots?: readonly string[];
    resolveProfileDefaults?: (
      cwd: string,
      config: Config
    ) => Promise<ProjectProfileAffinityDefaults | null>;
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
  if (options.disabled) return;

  if (projectRoots.length > 0) {
    return scoringInput(
      {
        roots: projectRoots.map((path) => ({
          path,
          source: "cli_explicit" as const,
        })),
      },
      {
        ...config,
        projectAffinity: {
          enabled: true,
          contribution:
            config.projectAffinity?.contribution ??
            PROJECT_AFFINITY_MAX_CONTRIBUTION,
        },
      },
      "local"
    );
  }

  const profileDefaults = await (
    options.resolveProfileDefaults ?? resolveProjectProfileAffinityDefaults
  )(options.cwd, config);
  if (profileDefaults) {
    if (!profileDefaults.enabled) return;
    return scoringInput(
      {
        roots: [
          {
            path: profileDefaults.profileRoot,
            source: "project_profile",
          },
        ],
      },
      {
        ...config,
        projectAffinity: {
          enabled: profileDefaults.enabled,
          contribution: profileDefaults.contribution,
        },
      },
      "local"
    );
  }

  if (config.projectAffinity?.enabled === false) return;
  return scoringInput(
    { roots: [{ path: options.cwd, source: "cli_cwd" }] },
    config,
    "local"
  );
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
