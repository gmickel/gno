/**
 * Local-only discovery for repository-owned `.gno/index.yml` profiles.
 *
 * Absolute paths stay inside this module. Callers must project the public,
 * redacted discovery summary before crossing a CLI/API boundary.
 *
 * @module src/core/project-profile-discovery
 */

// node:fs/promises provides directory metadata, lstat, and realpath; Bun has no
// equivalent directory/symlink inspection API.
import {
  lstat as defaultLstat,
  realpath as defaultRealpath,
  stat as defaultStat,
} from "node:fs/promises";
// node:path provides cross-platform path operations; Bun has no path utilities.
import { dirname, join, resolve } from "node:path";

import { isCanonicalPathContained } from "./validation";

export const PROJECT_PROFILE_RELATIVE_PATH = ".gno/index.yml" as const;

export type ProjectProfileDiscoveryDiagnosticCode =
  | "PROFILE_NOT_FOUND"
  | "PROFILE_NOT_REGULAR_FILE"
  | "PROFILE_SYMLINK_ESCAPE"
  | "PROFILE_DISCOVERY_FAILED"
  | "PROFILE_DISCOVERY_REMOTE_DISABLED"
  | "SHADOWED_PROFILE";

export interface ProjectProfileDiscoveryDiagnostic {
  code: ProjectProfileDiscoveryDiagnosticCode;
  severity: "error" | "warning";
  path: string;
  message: string;
  remediation: string;
}

export interface ProjectProfileDiscoverySummary {
  status: "found" | "not_found" | "disabled" | "error";
  source: "cwd" | "override" | "remote";
  boundary: "repository" | "filesystem" | "explicit" | "remote";
  profile: typeof PROJECT_PROFILE_RELATIVE_PATH | null;
  ambiguous: boolean;
  shadowedProfiles: number;
}

export interface ProjectProfileDiscoveryResult {
  summary: ProjectProfileDiscoverySummary;
  profilePath: string | null;
  profileRoot: string | null;
  diagnostics: ProjectProfileDiscoveryDiagnostic[];
}

interface FileMetadata {
  dev: number;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface ProjectProfileDiscoveryDependencies {
  lstat(path: string): Promise<FileMetadata>;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<FileMetadata>;
}

export interface DiscoverProjectProfileOptions {
  channel: "local" | "remote";
  cwd?: string;
  rootOverride?: string;
}

const defaultDependencies: ProjectProfileDiscoveryDependencies = {
  lstat: defaultLstat,
  realpath: defaultRealpath,
  stat: defaultStat,
};

const diagnostic = (
  code: ProjectProfileDiscoveryDiagnosticCode,
  severity: "error" | "warning",
  message: string,
  remediation: string
): ProjectProfileDiscoveryDiagnostic => ({
  code,
  severity,
  path: PROJECT_PROFILE_RELATIVE_PATH,
  message,
  remediation,
});

type PathProbe = "missing" | "present" | "unreadable";

const probePath = async (
  path: string,
  dependencies: ProjectProfileDiscoveryDependencies
): Promise<PathProbe> => {
  try {
    await dependencies.lstat(path);
    return "present";
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable";
  }
};

type ProfileCandidateResult =
  | { status: "missing" }
  | { status: "found"; profilePath: string }
  | { status: "error"; diagnostic: ProjectProfileDiscoveryDiagnostic };

const inspectProfileCandidate = async (
  profileRoot: string,
  dependencies: ProjectProfileDiscoveryDependencies
): Promise<ProfileCandidateResult> => {
  const candidate = join(profileRoot, PROJECT_PROFILE_RELATIVE_PATH);
  const candidateProbe = await probePath(candidate, dependencies);
  if (candidateProbe === "missing") {
    return { status: "missing" };
  }
  if (candidateProbe === "unreadable") {
    return {
      status: "error",
      diagnostic: diagnostic(
        "PROFILE_DISCOVERY_FAILED",
        "error",
        "The selected project profile could not be inspected safely.",
        "Repair directory permissions or select another exact profile root."
      ),
    };
  }

  let canonicalProfile: string;
  let metadata: FileMetadata;
  try {
    canonicalProfile = await dependencies.realpath(candidate);
    metadata = await dependencies.stat(canonicalProfile);
  } catch {
    return {
      status: "error",
      diagnostic: diagnostic(
        "PROFILE_DISCOVERY_FAILED",
        "error",
        "The selected project profile could not be resolved safely.",
        "Repair the profile file or select another exact profile root."
      ),
    };
  }

  if (!metadata.isFile()) {
    return {
      status: "error",
      diagnostic: diagnostic(
        "PROFILE_NOT_REGULAR_FILE",
        "error",
        "The selected project profile is not a regular file.",
        "Replace .gno/index.yml with a regular YAML file."
      ),
    };
  }
  if (!isCanonicalPathContained(profileRoot, canonicalProfile)) {
    return {
      status: "error",
      diagnostic: diagnostic(
        "PROFILE_SYMLINK_ESCAPE",
        "error",
        "The selected project profile resolves outside its trusted profile root.",
        "Replace the escaping symlink with a profile stored inside the project root."
      ),
    };
  }
  return { status: "found", profilePath: canonicalProfile };
};

const probeRepositoryMarker = (
  directory: string,
  dependencies: ProjectProfileDiscoveryDependencies
): Promise<PathProbe> => probePath(join(directory, ".git"), dependencies);

const remoteDisabledResult = (): ProjectProfileDiscoveryResult => ({
  summary: {
    status: "disabled",
    source: "remote",
    boundary: "remote",
    profile: null,
    ambiguous: false,
    shadowedProfiles: 0,
  },
  profilePath: null,
  profileRoot: null,
  diagnostics: [
    diagnostic(
      "PROFILE_DISCOVERY_REMOTE_DISABLED",
      "error",
      "Project profile discovery is disabled for remote callers.",
      "Run gno profile from a trusted local CLI working directory."
    ),
  ],
});

const errorResult = (
  source: "cwd" | "override",
  boundary: "filesystem" | "explicit",
  issue: ProjectProfileDiscoveryDiagnostic
): ProjectProfileDiscoveryResult => ({
  summary: {
    status: "error",
    source,
    boundary,
    profile: null,
    ambiguous: false,
    shadowedProfiles: 0,
  },
  profilePath: null,
  profileRoot: null,
  diagnostics: [issue],
});

const notFoundResult = (
  source: "cwd" | "override",
  boundary: "repository" | "filesystem" | "explicit"
): ProjectProfileDiscoveryResult => ({
  summary: {
    status: "not_found",
    source,
    boundary,
    profile: null,
    ambiguous: false,
    shadowedProfiles: 0,
  },
  profilePath: null,
  profileRoot: null,
  diagnostics: [
    diagnostic(
      "PROFILE_NOT_FOUND",
      "error",
      "No .gno/index.yml project profile was found inside the trusted discovery boundary.",
      source === "override"
        ? "Create .gno/index.yml at the selected root or choose another exact root."
        : "Create .gno/index.yml in this project or pass an exact profile root."
    ),
  ],
});

const explicitProfileRoot = async (
  input: string,
  dependencies: ProjectProfileDiscoveryDependencies
): Promise<
  | { ok: true; profileRoot: string; exactProfilePath: string | null }
  | { ok: false; diagnostic: ProjectProfileDiscoveryDiagnostic }
> => {
  const absoluteInput = resolve(input);
  let inputMetadata: FileMetadata;
  try {
    inputMetadata = await dependencies.stat(absoluteInput);
  } catch {
    return {
      ok: false,
      diagnostic: diagnostic(
        "PROFILE_DISCOVERY_FAILED",
        "error",
        "The explicit project profile path does not exist.",
        "Pass an existing directory or its .gno/index.yml file."
      ),
    };
  }

  try {
    if (inputMetadata.isDirectory()) {
      return {
        ok: true,
        profileRoot: await dependencies.realpath(absoluteInput),
        exactProfilePath: null,
      };
    }
    if (!inputMetadata.isFile()) {
      return {
        ok: false,
        diagnostic: diagnostic(
          "PROFILE_NOT_REGULAR_FILE",
          "error",
          "The explicit project profile path is neither a directory nor a regular file.",
          "Pass an existing directory or its .gno/index.yml file."
        ),
      };
    }

    const lexicalRoot = dirname(dirname(absoluteInput));
    const profileRoot = await dependencies.realpath(lexicalRoot);
    const exactProfilePath = await dependencies.realpath(absoluteInput);
    if (
      join(profileRoot, PROJECT_PROFILE_RELATIVE_PATH) !== exactProfilePath ||
      !isCanonicalPathContained(profileRoot, exactProfilePath)
    ) {
      return {
        ok: false,
        diagnostic: diagnostic(
          "PROFILE_SYMLINK_ESCAPE",
          "error",
          "The explicit file is not the canonical .gno/index.yml inside its trusted root.",
          "Pass the project root or its non-escaping .gno/index.yml file."
        ),
      };
    }
    return { ok: true, profileRoot, exactProfilePath };
  } catch {
    return {
      ok: false,
      diagnostic: diagnostic(
        "PROFILE_DISCOVERY_FAILED",
        "error",
        "The explicit project profile path could not be resolved safely.",
        "Repair the path or select another exact profile root."
      ),
    };
  }
};

const discoverExplicitProfile = async (
  input: string,
  dependencies: ProjectProfileDiscoveryDependencies
): Promise<ProjectProfileDiscoveryResult> => {
  const resolved = await explicitProfileRoot(input, dependencies);
  if (!resolved.ok) {
    return errorResult("override", "explicit", resolved.diagnostic);
  }
  const candidate = await inspectProfileCandidate(
    resolved.profileRoot,
    dependencies
  );
  if (candidate.status === "error") {
    return errorResult("override", "explicit", candidate.diagnostic);
  }
  if (candidate.status === "missing") {
    return notFoundResult("override", "explicit");
  }
  if (
    resolved.exactProfilePath &&
    resolved.exactProfilePath !== candidate.profilePath
  ) {
    return errorResult(
      "override",
      "explicit",
      diagnostic(
        "PROFILE_SYMLINK_ESCAPE",
        "error",
        "The explicit profile identity changed during discovery.",
        "Repair the profile symlink and retry."
      )
    );
  }
  return {
    summary: {
      status: "found",
      source: "override",
      boundary: "explicit",
      profile: PROJECT_PROFILE_RELATIVE_PATH,
      ambiguous: false,
      shadowedProfiles: 0,
    },
    profilePath: candidate.profilePath,
    profileRoot: resolved.profileRoot,
    diagnostics: [],
  };
};

const startingDirectory = async (
  input: string,
  dependencies: ProjectProfileDiscoveryDependencies
): Promise<{ path: string; dev: number }> => {
  const canonical = await dependencies.realpath(resolve(input));
  const metadata = await dependencies.stat(canonical);
  const path = metadata.isDirectory() ? canonical : dirname(canonical);
  const directoryMetadata = metadata.isDirectory()
    ? metadata
    : await dependencies.stat(path);
  return { path, dev: directoryMetadata.dev };
};

const discoverFromCwd = async (
  cwd: string,
  dependencies: ProjectProfileDiscoveryDependencies
): Promise<ProjectProfileDiscoveryResult> => {
  let start: { path: string; dev: number };
  try {
    start = await startingDirectory(cwd, dependencies);
  } catch {
    return errorResult(
      "cwd",
      "filesystem",
      diagnostic(
        "PROFILE_DISCOVERY_FAILED",
        "error",
        "The local discovery starting path could not be resolved.",
        "Run the command from an existing readable directory."
      )
    );
  }

  const candidates: Array<{ profilePath: string; profileRoot: string }> = [];
  let current = start.path;
  let boundary: "repository" | "filesystem" = "filesystem";

  while (true) {
    const candidate = await inspectProfileCandidate(current, dependencies);
    if (candidate.status === "error") {
      return errorResult("cwd", boundary, candidate.diagnostic);
    }
    if (candidate.status === "found") {
      candidates.push({
        profilePath: candidate.profilePath,
        profileRoot: current,
      });
    }

    const repositoryMarker = await probeRepositoryMarker(current, dependencies);
    if (repositoryMarker === "unreadable") {
      return errorResult(
        "cwd",
        boundary,
        diagnostic(
          "PROFILE_DISCOVERY_FAILED",
          "error",
          "The repository boundary could not be inspected safely.",
          "Repair directory permissions or pass an exact profile root."
        )
      );
    }
    if (repositoryMarker === "present") {
      boundary = "repository";
      break;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    try {
      const parentMetadata = await dependencies.stat(parent);
      if (!parentMetadata.isDirectory() || parentMetadata.dev !== start.dev) {
        break;
      }
    } catch {
      break;
    }
    current = parent;
  }

  const selected = candidates[0];
  if (!selected) {
    return notFoundResult("cwd", boundary);
  }
  const shadowedProfiles = candidates.length - 1;
  return {
    summary: {
      status: "found",
      source: "cwd",
      boundary,
      profile: PROJECT_PROFILE_RELATIVE_PATH,
      ambiguous: shadowedProfiles > 0,
      shadowedProfiles,
    },
    profilePath: selected.profilePath,
    profileRoot: selected.profileRoot,
    diagnostics:
      shadowedProfiles > 0
        ? [
            diagnostic(
              "SHADOWED_PROFILE",
              "warning",
              `The nearest profile was selected; ${shadowedProfiles} ancestor profile${shadowedProfiles === 1 ? " was" : "s were"} shadowed and not merged.`,
              "Pass an explicit profile root to inspect an ancestor profile."
            ),
          ]
        : [],
  };
};

/**
 * Discover one trusted local profile. Remote requests return before touching
 * dependency functions, proving they cannot trigger filesystem probes.
 */
export async function discoverProjectProfile(
  options: DiscoverProjectProfileOptions,
  overrides: Partial<ProjectProfileDiscoveryDependencies> = {}
): Promise<ProjectProfileDiscoveryResult> {
  if (options.channel === "remote") {
    return remoteDisabledResult();
  }
  const dependencies: ProjectProfileDiscoveryDependencies = {
    ...defaultDependencies,
    ...overrides,
  };
  if (options.rootOverride) {
    return discoverExplicitProfile(options.rootOverride, dependencies);
  }
  return discoverFromCwd(options.cwd ?? process.cwd(), dependencies);
}
